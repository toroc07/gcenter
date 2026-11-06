'use strict';

/**
 * Servidor MCP de GCenter.
 *
 * Es el brazo ejecutor del orquestador (Claude Code u OpenCode): llama a estas
 * herramientas para repartir trabajo entre los agentes que el usuario haya
 * configurado, y cada llamada emite telemetria al sidebar para que se vea quien
 * esta trabajando y con que modelo.
 *
 * Con el filtro de gratuidad activo, ninguna delegacion sale de aqui sin pasar
 * antes por la politica de gratuidad del agente.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const providers = require('./providers');
const health = require('./health');
const quality = require('./quality');
const capabilities = require('./capabilities');
const workspace = require('./workspace');
const feedback = require('./feedback');
const bus = require('./bus-client');
const config = require('../shared/config');

/** Nombre del orquestador, para que los avisos digan a quien le toca. */
const JEFE = process.env.GCENTER_ORCHESTRATOR || 'el orquestador';

/** Ids de los agentes configurados. Se leen en cada uso: son baratos. */
function agentIds() {
  return providers.listAgents().map((a) => a.id);
}

// Agentes vivos ahora mismo, por id
const running = new Map();
// Acumulado de la sesion, para el panel de estadisticas
const stats = { delegations: 0, completed: 0, failed: 0, tokensIn: 0, tokensOut: 0 };

let seq = 0;
function nextId() {
  seq += 1;
  return 'w' + Date.now().toString(36) + '-' + seq;
}

function emitStats() {
  bus.send({ type: 'stats', stats: Object.assign({}, stats) });
}

/** Avisa al sidebar del estado del equipo tras cada delegacion. */
function emitHealth() {
  bus.send({ type: 'health', proveedores: health.resumen(agentIds()) });
}

/**
 * Decide quien hace la tarea.
 *
 * Si vienen `provider` y `model` se respetan. Si en su lugar viene una
 * `capability`, se busca el mejor agente vivo para esa especialidad, y si no
 * queda ninguno se devuelve null: esa es la senal de que le toca al orquestador.
 */
async function elegirEjecutor(task) {
  // Ya asignado por el reparto de un lote paralelo
  if (task.asignado) return task.asignado;

  if (task.provider && task.model) {
    return { provider: String(task.provider).trim(), model: task.model };
  }
  if (task.capability) {
    const lista = await capabilities.candidatos(task.capability, {
      excluir: task.excluir,
      excluirModelos: task.excluirModelos
    });
    if (!lista.length) return null;

    // De los candidatos, el que menos agentes tiene ahora mismo en marcha.
    // Sin esto, todos los reintentos de un lote convergian en el favorito y
    // volvian a amontonarse en el mismo modelo. En caso de empate se respeta
    // el orden de preferencia, porque sort es estable.
    const carga = (c) => [...running.values()]
      .filter((r) => r.provider === c.provider && r.model === c.model).length;
    return lista.slice().sort((a, b) => carga(a) - carga(b))[0];
  }
  throw new Error('Hay que indicar provider+model, o bien capability.');
}

/**
 * Ejecuta una tarea en un agente subordinado y va reportando su estado.
 * Nunca lanza: devuelve siempre un objeto con `ok` para que un fallo de un
 * agente no tumbe a los demas de un lote paralelo.
 */
async function runAgent(task, opts) {
  const cfg = config.load();
  const id = nextId();
  const role = (task.role || 'AGENTE').toString().slice(0, 24);
  // Cuantas veces se ha reencaminado ya esta tarea. Los fallos de calidad o de
  // cuota solo merecen un segundo intento; un modelo que no esta servido
  // falla al instante y gratis, asi que ahi se puede probar alguno mas.
  const intentos = (opts && opts.intentos) || 0;
  const reintento = intentos > 0;

  let elegido;
  try {
    elegido = await elegirEjecutor(task);
  } catch (err) {
    return { ok: false, id, role, error: err.message };
  }

  // Nadie puede cubrir esta capacidad: el jefe tiene que hacerlo el mismo
  if (!elegido) {
    const cob = await capabilities.cobertura();
    const sinCubrir = cob.filter((c) => !c.cubierta).map((c) => c.capacidad);
    return {
      ok: false,
      id,
      role,
      capability: task.capability,
      sinAgentes: true,
      error:
        'SIN AGENTES DISPONIBLES para la capacidad "' + task.capability + '". ' +
        (agentIds().length
          ? 'Todos los agentes aptos estan agotados, degradados o bloqueados por el filtro de gratuidad. '
          : 'El usuario no ha configurado ningun agente. ') +
        'HAZLO TU MISMO y sigue adelante con el proyecto; no bloquees el trabajo esperando. ' +
        'Capacidades actualmente sin cubrir: ' + (sinCubrir.join(', ') || 'ninguna mas') + '.'
    };
  }

  const providerId = elegido.provider;
  const model = elegido.model;

  let agent;
  try {
    agent = providers.getAgent(providerId);
  } catch (err) {
    return { ok: false, id, role, provider: providerId, model, error: err.message };
  }
  const providerMeta = agent;

  // Barrera de gratuidad: se comprueba ANTES de crear la tarjeta en el sidebar,
  // para que un modelo de pago ni siquiera llegue a parecer que se ejecuto
  if (cfg.freeOnly !== false) {
    const verdict = await providers.checkFree(agent, model);
    if (!verdict.ok) {
      stats.failed += 1;
      emitStats();
      const alt = verdict.alternatives && verdict.alternatives.length
        ? ' Modelos gratuitos de ' + agent.label + ' ahora mismo: ' + verdict.alternatives.join(', ') + '.'
        : ' Llama a agents_available para ver la lista vigente.';
      return {
        ok: false,
        id,
        role,
        provider: providerId,
        model,
        error: 'BLOQUEADO POR LA POLITICA DE GRATUIDAD: ' + verdict.reason + '.' + alt
      };
    }
  }

  // Una ruta de salida fuera del proyecto se rechaza ANTES de llamar al agente:
  // si se comprobase al escribir, el agente ya habria gastado cuota en un
  // resultado que nunca se va a poder guardar
  if (task.output_file) {
    try {
      workspace.resolver(task.output_file);
    } catch (err) {
      return { ok: false, id, role, provider: providerId, providerLabel: agent.label, model, error: err.message };
    }
  }

  // Los archivos de contexto los lee el servidor, no el orquestador: asi el contenido
  // llega al agente sin que el jefe lo tenga que teclear en el prompt
  const contexto = workspace.leerContexto(task.context_files);

  // Si se pide escribir a disco pero el modo de permisos exige supervision,
  // no lo hacemos por la puerta de atras: el texto vuelve al jefe y decide el
  const escribir = Boolean(task.output_file) && workspace.escrituraPermitida();

  const instruccionSalida = task.output_file
    ? '\n\n## Formato de la respuesta\nDevuelve UNICAMENTE el contenido completo del archivo `' +
      task.output_file + '` dentro de un solo bloque de codigo. Sin explicaciones antes ni despues, ' +
      'sin fragmentos sueltos, sin "el resto queda igual": el archivo entero, listo para guardar.'
    : '';

  const card = {
    id,
    role,
    provider: providerId,
    providerLabel: providerMeta.label,
    color: providerMeta.color,
    model,
    status: 'running',
    startedAt: Date.now(),
    chars: 0,
    task: String(task.prompt || '').slice(0, 200)
  };
  running.set(id, card);

  bus.send({ type: 'agent.start', agent: card });
  stats.delegations += 1;
  emitStats();

  try {
    // Throttle de los eventos de progreso: no hace falta repintar por cada token
    let lastPing = 0;
    const result = await providers.chat({
      agent,
      model,
      system: task.system,
      prompt: String(task.prompt || '') + contexto.texto + instruccionSalida,
      temperature: typeof task.temperature === 'number' ? task.temperature : 0.3,
      maxTokens: typeof task.max_tokens === 'number' ? task.max_tokens : 4096,
      timeoutMs: cfg.agentTimeoutMs,
      onDelta: (_delta, full, meta) => {
        // Contamos tambien los caracteres de razonamiento: si no, un modelo
        // que piensa durante un minuto parece congelado en el sidebar
        const chars = full.length + ((meta && meta.reasoningChars) || 0);
        card.chars = chars;
        const now = Date.now();
        if (now - lastPing > 120) {
          lastPing = now;
          bus.send({
            type: 'agent.progress',
            id,
            chars,
            thinking: Boolean(meta && meta.thinking)
          });
        }
      }
    });

    const usage = result.usage || {};
    stats.tokensIn += usage.prompt_tokens || 0;
    stats.tokensOut += usage.completion_tokens || 0;
    stats.completed += 1;

    // Una llamada con exito tecnico puede traer basura: repeticiones, el
    // enunciado copiado, una negativa. Lo miramos antes de darlo por bueno.
    const veredicto = quality.evaluar({
      text: result.text,
      finishReason: result.finishReason,
      prompt: task.prompt,
      maxTokens: typeof task.max_tokens === 'number' ? task.max_tokens : 4096
    });

    // Si va a disco, comprobamos que compila ANTES de escribirlo: un archivo
    // que ni siquiera parsea es un fallo inequivoco y gratis de detectar
    if (task.output_file) {
      const sintaxis = workspace.comprobarSintaxis(
        task.output_file,
        workspace.extraerArchivo(result.text)
      );
      if (sintaxis.ok === false) {
        veredicto.problemas.push('el archivo no compila (' + sintaxis.detalle + ')');
        veredicto.gravedad = 'grave';
        veredicto.ok = false;
      }
    }

    health.registrarExito(providerId, result.elapsedMs, veredicto.gravedad !== 'ninguna');
    health.registrarRecuperacion(providerId);

    card.status = veredicto.gravedad === 'grave' ? 'poor' : 'done';
    running.delete(id);

    bus.send({
      type: 'agent.done',
      id,
      role,
      elapsedMs: result.elapsedMs,
      tokensIn: usage.prompt_tokens || 0,
      tokensOut: usage.completion_tokens || 0,
      chars: result.text.length,
      calidad: veredicto.gravedad,
      problemas: veredicto.problemas
    });
    emitStats();
    emitHealth();

    // Si la respuesta es claramente mala, le damos una oportunidad a OTRO
    // proveedor antes de molestar al jefe con ella. Solo una: si el segundo
    // tambien falla, que lo vea y decida.
    if (veredicto.gravedad === 'grave' && !reintento && task.capability) {
      const segundo = await runAgent(
        Object.assign({}, task, { asignado: null, excluir: [providerId] }),
        { intentos: intentos + 1 }
      );
      if (segundo.ok) {
        segundo.reemplazoDe = providerMeta.label + ' (' + veredicto.problemas.join('; ') + ')';
        return segundo;
      }
    }

    // Escribimos a disco solo lo que no salio claramente mal: guardar basura
    // obligaria al jefe a leerla entera para descubrir que hay que tirarla
    let archivo = null;
    let errorEscritura = null;
    if (escribir && veredicto.gravedad !== 'grave') {
      try {
        archivo = workspace.escribirResultado(task.output_file, result.text);
      } catch (err) {
        errorEscritura = err.message;
      }
    }

    return {
      ok: true,
      id,
      role,
      provider: providerId,
      providerLabel: providerMeta.label,
      model: result.model,
      substituted: result.substituted,
      text: result.text,
      elapsedMs: result.elapsedMs,
      usage,
      calidad: veredicto,
      contexto,
      archivo,
      errorEscritura,
      // Pidio escribir pero el modo de permisos no lo deja: hay que avisarle
      escrituraBloqueada: Boolean(task.output_file) && !escribir
    };
  } catch (err) {
    stats.failed += 1;
    const tipo = health.registrarFallo(providerId, err.message);
    card.status = 'error';
    running.delete(id);

    bus.send({ type: 'agent.error', id, role, error: err.message, tipo });
    emitStats();
    emitHealth();

    // Ninguno de estos fallos es culpa de la tarea: la misma peticion puede
    // salir bien en otro sitio, asi que la reencaminamos una vez. Si el
    // problema es el proveedor (cuota, creditos, lentitud) lo evitamos entero;
    // si es un modelo concreto que no esta servido, basta con saltarse ese
    // modelo, que ya quedo apartado del catalogo.
    const reencaminable = ['cuota', 'creditos', 'lentitud', 'modelo', 'red', 'acceso', 'credenciales'].includes(tipo);
    const tope = tipo === 'modelo' ? 3 : 1;
    if (intentos < tope && task.capability && reencaminable) {
      const exclusion = tipo === 'modelo'
        ? { excluirModelos: [providerId + '|' + model] }
        : { excluir: [providerId] };
      const alternativo = await runAgent(
        Object.assign({}, task, { asignado: null }, exclusion),
        { intentos: intentos + 1 }
      );
      if (alternativo.ok) {
        alternativo.reemplazoDe = providerMeta.label + ' (' + tipo + ')';
        return alternativo;
      }
      return alternativo;
    }

    return { ok: false, id, role, provider: providerId, model, error: err.message, tipo };
  }
}

/** Da formato al resultado de un agente para devolverselo al orquestador. */
function formatResult(r) {
  const head = '### ' + r.role +
    (r.provider ? '  [' + (r.providerLabel || r.provider) + ' / ' + r.model + ']' : '');

  if (!r.ok) {
    return head + '\n' + (r.sinAgentes ? 'RELEVO AL JEFE: ' : 'FALLO: ') + r.error;
  }

  const secs = (r.elapsedMs / 1000).toFixed(1);
  const out = (r.usage && r.usage.completion_tokens) || '?';
  const notas = [];

  if (r.substituted) {
    notas.push('"' + r.substituted + '" ya no existe; el proveedor redirigio a "' + r.model +
      '". Usa este id a partir de ahora.');
  }
  if (r.reemplazoDe) {
    notas.push('Esta respuesta viene de un agente de repuesto. El primero, ' + r.reemplazoDe +
      ', no sirvio.');
  }
  if (r.calidad && r.calidad.problemas.length) {
    notas.push('CONTROL DE CALIDAD (' + r.calidad.gravedad + '): ' + r.calidad.problemas.join('; ') +
      '. Revisa esta respuesta con especial cuidado antes de usarla.');
  }

  if (r.contexto && r.contexto.faltan.length) {
    notas.push('No se pudieron adjuntar: ' + r.contexto.faltan.join('; ') + '.');
  }
  if (r.escrituraBloqueada) {
    notas.push('No se escribio a disco porque el modo de permisos actual exige supervision. ' +
      'El contenido va abajo; guardalo tu si lo das por bueno.');
  }
  if (r.errorEscritura) {
    notas.push('No se pudo escribir el archivo: ' + r.errorEscritura);
  }

  const bloque = notas.length ? '\n' + notas.map((n) => 'NOTA: ' + n).join('\n') : '';
  const cab = head + '\n(' + secs + 's, ' + out + ' tokens generados, ' +
    'id="' + r.id + '")' + bloque;

  // Si el archivo ya esta en disco, NO devolvemos su contenido: es justo lo que
  // ahorra tokens. Solo un resumen para revisar; si hace falta mas, Read.
  if (r.archivo) {
    const a = r.archivo;
    const sint = a.sintaxis.ok === true ? 'OK - ' : a.sintaxis.ok === false ? 'FALLA - ' : '';
    return cab +
      '\n\nARCHIVO ' + a.accion.toUpperCase() + ': ' + a.ruta + '  (' + a.lineas + ' lineas, ' + a.bytes + ' bytes)' +
      '\nSintaxis: ' + sint + a.sintaxis.detalle +
      (a.copia ? '\nCopia de la version anterior: ' + a.copia : '') +
      '\n\nPrimeras lineas:\n```\n' + a.inicio + '\n```' +
      (a.final ? '\nUltimas lineas:\n```\n' + a.final + '\n```' : '') +
      '\n\nRevisa con Read solo lo que necesites comprobar, y corrige con Edit. No lo reescribas entero.';
  }

  return cab + '\n\n' + r.text;
}

function text(s) {
  return { content: [{ type: 'text', text: s }] };
}

/**
 * Aviso que se cuelga al final de una delegacion cuando el equipo empieza a
 * flaquear. La idea es que el jefe se entere en el momento, sin tener que
 * acordarse de preguntar.
 */
async function avisoDeSalud() {
  const agentes = providers.listAgents();
  const malos = health.resumen(agentes.map((a) => a.id)).filter((f) => f.nivel !== 'sano');
  if (!malos.length) return '';

  const lineas = ['', '---', '', '## Aviso del supervisor'];
  for (const f of malos) {
    const meta = agentes.find((a) => a.id === f.providerId) || { label: f.providerId };
    lineas.push('- ' + meta.label + ': ' + f.nivel.toUpperCase() +
      (f.motivoAgotado ? ' (' + f.motivoAgotado + ', ~' + f.minutosParaReintentar + ' min)' : '') +
      ' — ' + f.ok + ' ok / ' + f.fallos + ' fallos');
  }

  const cob = await capabilities.cobertura();
  const huerfanas = cob.filter((c) => !c.cubierta);
  if (huerfanas.length) {
    lineas.push('');
    lineas.push('SIN CUBRIR: ' + huerfanas.map((h) => h.capacidad).join(', ') +
      '. Ese trabajo pasa a ser tuyo: hazlo y continua, no esperes a que vuelvan.');
  }

  return lineas.join('\n');
}

async function main() {
  const server = new McpServer({ name: 'gcenter', version: require('../../package.json').version });

  server.registerTool(
    'agents_available',
    {
      title: 'Ver agentes disponibles',
      description:
        'Lista los agentes que el usuario ha configurado y sus modelos utilizables AHORA MISMO, consultando ' +
        'el catalogo en vivo de cada uno. Llamala al empezar la sesion, y de nuevo si una delegacion falla ' +
        'por modelo invalido. Los ids de modelo cambian cada pocas semanas: no te fies de los que recuerdes ' +
        'de otras conversaciones, usa solo los que devuelva esta herramienta.',
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe('Ignora la cache de 10 minutos y vuelve a preguntar a cada agente.')
      }
    },
    async (args) => {
      const force = Boolean(args && args.refresh);
      const soloGratis = config.load().freeOnly !== false;
      const list = providers.listAgents();
      const lines = ['# Agentes disponibles en GCenter', ''];
      lines.push('Filtro de gratuidad: ' + (soloGratis
        ? 'ACTIVO (solo modelos gratuitos verificados)'
        : 'DESACTIVADO por el usuario (se permiten modelos de pago)'));
      lines.push('');

      if (!list.length) {
        lines.push('EL USUARIO NO HA CONFIGURADO NINGUN AGENTE.');
        lines.push('Haz tu el trabajo. Si la tarea es grande, sugierele que anada alguno desde el boton');
        lines.push('de agentes del sidebar de GCenter: basta con un nombre y una API key de su cuenta.');
        return text(lines.join('\n'));
      }

      // En serie, varios proveedores lentos sumarian mas de un minuto de espera
      const results = await Promise.all(
        list.map(async (a) => ({ a, catalog: await providers.fetchModels(a, { force }) }))
      );

      let activos = 0;
      for (const { a, catalog } of results) {
        if (!catalog.ok) {
          lines.push('## ' + a.label + '  [NO RESPONDE: ' + catalog.error + ']');
          lines.push('   No delegues aqui hasta que vuelva. Usa otro agente.');
          lines.push('');
          continue;
        }
        if (catalog.bloqueado) {
          lines.push('## ' + a.label + '  [BLOQUEADO: gratuidad no verificable]');
          lines.push('   Su catalogo no publica precios y el filtro de gratuidad esta activo. No delegues aqui.');
          lines.push('');
          continue;
        }
        if (!catalog.models.length) {
          lines.push('## ' + a.label + '  [SIN MODELOS UTILIZABLES]');
          lines.push('');
          continue;
        }

        activos += 1;
        lines.push('## ' + a.label + '  [ACTIVO]  provider="' + a.id + '"' +
          (a.custom ? '' : '  (' + a.providerLabel + ')'));
        if (!a.custom) {
          lines.push('   Cuota: ' + a.free);
          lines.push('   Fuerte en: ' + a.strengths);
        }
        lines.push('   Modelos ' + (soloGratis ? 'gratuitos ' : '') + 'de chat (' + catalog.models.length +
          ' de ' + (catalog.totalSeen || catalog.models.length) + ' del catalogo):');
        for (const m of catalog.models.slice(0, 40)) lines.push('     - ' + m);
        if (catalog.models.length > 40) lines.push('     ... y ' + (catalog.models.length - 40) + ' mas');
        lines.push('');
      }

      lines.push('# Reglas');
      lines.push('- Usa SOLO ids de los listados arriba, con el provider="..." de su agente.');
      if (soloGratis) {
        lines.push('- Cualquier otro modelo se rechaza antes de llamar al proveedor, porque podria cobrar.');
      }
      lines.push('- Puedes lanzar varios agentes del mismo proveedor con modelos distintos a la vez,');
      lines.push('  por ejemplo para contrastar dos respuestas al mismo problema.');
      if (activos === 0) {
        lines.push('- AHORA MISMO NO HAY NINGUN AGENTE UTILIZABLE: haz tu el trabajo y avisa al usuario');
        lines.push('  de que revise sus agentes en el sidebar de GCenter.');
      }

      return text(lines.join('\n'));
    }
  );

  server.registerTool(
    'delegate',
    {
      title: 'Delegar una tarea a un agente',
      description:
        'Envia UNA tarea a un agente subordinado y devuelve su respuesta. Usala para todo lo que no ' +
        'requiera tu criterio directo: generar codigo repetitivo, resumir, traducir, explicar, buscar patrones, ' +
        'redactar tests o documentacion. El prompt debe ser AUTOCONTENIDO: el agente no ve la conversacion ni ' +
        'tiene acceso al disco, asi que incluye dentro del prompt todo el codigo o contexto que necesite.',
      inputSchema: {
        role: z
          .string()
          .describe('Etiqueta corta en MAYUSCULAS que se mostrara en el sidebar. Ej: "CODER", "AUDITOR SQL", "TESTER".'),
        capability: z
          .enum(capabilities.NOMBRES)
          .optional()
          .describe(
            'Forma recomendada de delegar: pide una especialidad y GCenter elige el mejor agente vivo, ' +
            'reencamina solo si falla, y te avisa si no queda ninguno. Alternativa a provider+model.'
          ),
        provider: z
          .string()
          .optional()
          .describe('Id de un agente concreto (provider="..." en agents_available), si prefieres elegir a mano. Requiere tambien `model`.'),
        model: z
          .string()
          .optional()
          .describe('Id exacto de un modelo listado por agents_available. Con el filtro de gratuidad activo, los de pago se rechazan.'),
        prompt: z
          .string()
          .describe(
            'Que hay que hacer: requisitos, interfaces, nombres, decisiones. NO pegues aqui el contenido de ' +
            'archivos del proyecto: para eso esta context_files, que lo adjunta sin gastar tus tokens.'
          ),
        context_files: z
          .array(z.string())
          .optional()
          .describe(
            'Rutas (relativas al directorio de trabajo) de archivos que el agente necesita ver. GCenter los ' +
            'lee y se los adjunta: tu no tecleas su contenido.'
          ),
        output_file: z
          .string()
          .optional()
          .describe(
            'Ruta relativa donde guardar el resultado. GCenter extrae el archivo de la respuesta, comprueba ' +
            'la sintaxis y lo escribe a disco; tu recibes solo un resumen. USALO SIEMPRE que la tarea sea ' +
            'producir un archivo: es lo que hace que delegar ahorre tokens en vez de gastarlos dos veces.'
          ),
        system: z.string().optional().describe('Instruccion de sistema que define la especialidad del agente.'),
        temperature: z.number().min(0).max(2).optional().describe('Por defecto 0.3. Sube a 0.7+ para tareas creativas.'),
        max_tokens: z.number().int().min(64).max(32000).optional().describe('Tope de tokens de la respuesta. Por defecto 4096; para un archivo entero, 8000 o mas.')
      }
    },
    async (args) => {
      const r = await runAgent(args);
      return text(formatResult(r) + (await avisoDeSalud()));
    }
  );

  server.registerTool(
    'delegate_parallel',
    {
      title: 'Delegar varias tareas en paralelo',
      description:
        'Lanza VARIAS tareas a la vez, cada una en su propio agente, y espera a que todas terminen. ' +
        'Es la herramienta preferida cuando el trabajo se puede trocear: cada agente aparece como una tarjeta ' +
        'independiente en el sidebar. Puedes mezclar agentes y modelos libremente, incluso repetir agente ' +
        'con modelos distintos para contrastar respuestas. Si un agente falla, los demas siguen y te llega el ' +
        'error solo de ese.',
      inputSchema: {
        tasks: z
          .array(
            z.object({
              role: z.string().describe('Etiqueta corta en MAYUSCULAS para el sidebar.'),
              capability: z.enum(capabilities.NOMBRES).optional()
                .describe('Especialidad pedida; GCenter elige el agente vivo. Alternativa a provider+model.'),
              provider: z.string().optional().describe('Id de un agente concreto, si lo eliges a mano.'),
              model: z.string().optional().describe('Id exacto de un modelo listado por agents_available.'),
              prompt: z.string().describe('Que hay que hacer. El contenido de archivos va en context_files.'),
              context_files: z.array(z.string()).optional()
                .describe('Archivos del proyecto que el agente necesita ver; GCenter los adjunta.'),
              output_file: z.string().optional()
                .describe('Donde guardar el resultado; GCenter lo escribe y te devuelve un resumen.'),
              system: z.string().optional().describe('Instruccion de sistema del especialista.'),
              temperature: z.number().min(0).max(2).optional(),
              max_tokens: z.number().int().min(64).max(32000).optional()
            })
          )
          .min(1)
          .max(8)
          .describe('Lista de tareas a ejecutar simultaneamente.')
      }
    },
    async (args) => {
      const cfg = config.load();
      const tasks = args.tasks.slice(0, cfg.maxParallelAgents);

      // Las tareas que piden la misma capacidad se reparten entre modelos
      // distintos: si todas caen en el mismo y ese escribe mal, sale mal el
      // lote entero y el jefe acaba rehaciendolo todo
      const asignados = await capabilities.repartir(tasks);
      const conAsignacion = tasks.map((t, i) =>
        asignados[i] ? Object.assign({}, t, { asignado: asignados[i] }) : t
      );

      const started = Date.now();
      const results = await Promise.all(conAsignacion.map((t) => runAgent(t)));
      const wall = ((Date.now() - started) / 1000).toFixed(1);

      const okCount = results.filter((r) => r.ok).length;
      const header =
        '# Lote paralelo: ' + okCount + '/' + results.length + ' agentes completados en ' + wall + 's\n';

      return text(
        header + '\n' + results.map(formatResult).join('\n\n---\n\n') + (await avisoDeSalud())
      );
    }
  );

  server.registerTool(
    'agents_health',
    {
      title: 'Supervisar el estado del equipo',
      description:
        'Parte de situacion del equipo: fiabilidad de cada agente, cuales estan agotados o dando ' +
        'respuestas malas, y que capacidades han quedado SIN CUBRIR y por tanto te tocan a ti. ' +
        'Consultala cada pocas delegaciones, y siempre que veas fallos repetidos o respuestas de mala ' +
        'calidad, para reajustar el reparto antes de que el problema se propague al proyecto.',
      inputSchema: {}
    },
    async () => {
      const agentes = providers.listAgents();
      const filas = health.resumen(agentes.map((a) => a.id));
      const cob = await capabilities.cobertura();
      const lines = ['# Parte de situacion del equipo', ''];

      lines.push('## Agentes');
      if (!agentes.length) lines.push('  (el usuario no ha configurado ningun agente)');
      for (const f of filas) {
        const meta = agentes.find((a) => a.id === f.providerId);
        if (!meta.key) {
          lines.push('  ' + meta.label.padEnd(16) + 'sin API key');
          continue;
        }
        if (f.ok + f.fallos === 0) {
          lines.push('  ' + meta.label.padEnd(16) + 'sin usar todavia');
          continue;
        }

        const marca = { sano: 'SANO', degradado: 'DEGRADADO', agotado: 'AGOTADO' }[f.nivel];
        let linea = '  ' + meta.label.padEnd(16) + marca.padEnd(11) +
          f.ok + ' ok / ' + f.fallos + ' fallos (' + f.fiabilidad + '% fiable)';
        if (f.msMedio) linea += ', ' + (f.msMedio / 1000).toFixed(1) + 's de media';
        lines.push(linea);

        if (f.motivoAgotado) {
          lines.push('       ' + f.motivoAgotado + '; se reintenta en ~' + f.minutosParaReintentar + ' min');
        }
        if (f.avisosCalidad) {
          lines.push('       ' + f.avisosCalidad + ' respuestas marcadas por el control de calidad');
        }
        if (f.nivel !== 'sano' && f.ultimoError) {
          lines.push('       ultimo error: ' + f.ultimoError.slice(0, 160));
        }
      }

      lines.push('');
      lines.push('## Capacidades');
      const huerfanas = [];
      for (const c of cob) {
        if (c.cubierta) {
          lines.push('  ' + c.capacidad.padEnd(14) + 'cubierta por ' + c.label + ' / ' + c.model +
            '  (provider="' + c.provider + '")');
        } else {
          huerfanas.push(c);
          lines.push('  ' + c.capacidad.padEnd(14) + 'SIN CUBRIR -> ' + c.descripcion);
        }
      }

      lines.push('');
      if (huerfanas.length) {
        lines.push('# ACCION REQUERIDA');
        lines.push('Estas capacidades se han quedado sin agentes: ' +
          huerfanas.map((h) => h.capacidad).join(', ') + '.');
        lines.push('Asume tu ese trabajo y continua el proyecto desde donde se quedo. No lo aplaces');
        lines.push('ni esperes a que vuelvan: avisa al usuario de que lo haces tu y sigue.');
      } else {
        lines.push('Todas las capacidades estan cubiertas. Sigue delegando con normalidad.');
      }

      return text(lines.join('\n'));
    }
  );

  server.registerTool(
    'agents_feedback',
    {
      title: 'Valorar el trabajo de un agente',
      description:
        'Registra tu veredicto como revisor sobre lo que entrego un agente. El reparto por capacidad lo usa ' +
        'para preferir los modelos que rinden bien en este proyecto y apartar los que hay que rehacer. ' +
        'Hazlo SIEMPRE que tengas que corregir de forma importante o descartar un resultado, y tambien ' +
        'cuando uno salga especialmente bien: sin estas valoraciones el reparto no aprende.',
      inputSchema: {
        provider: z.string().describe('Id del agente que hizo el trabajo (el que aparece entre corchetes en su resultado).'),
        model: z.string().describe('Modelo exacto que hizo el trabajo.'),
        rating: z.enum(['bueno', 'regular', 'malo']).describe(
          'bueno = usable tal cual o con retoques minimos; regular = sirvio pero hubo que corregir; ' +
          'malo = hubo que tirarlo o rehacerlo.'
        ),
        reason: z.string().describe('Que fallo o que salio bien, en una frase.')
      }
    },
    async (args) => {
      const f = feedback.valorar(args.provider, args.model, args.rating, args.reason);
      // Un suspenso cuenta tambien como aviso de calidad en la salud del proveedor
      if (args.rating === 'malo') health.registrarAvisoCalidad(args.provider);
      emitHealth();

      const veto = feedback.vetado(args.provider, args.model);
      return text(
        'Valoracion registrada: ' + args.provider + ' / ' + args.model + ' -> ' + args.rating + '. ' +
        'Historial: ' + f.bueno + ' buenos, ' + f.regular + ' regulares, ' + f.malo + ' malos.' +
        (veto
          ? ' Este modelo queda fuera del reparto automatico; sigue disponible si lo pides a mano.'
          : '') +
        (args.rating === 'malo'
          ? '\n\nSiguiente paso: vuelve a delegar la misma tarea con instrucciones mas precisas; el reparto ' +
            'ya elegira otro modelo. Solo asumela tu si fallan dos modelos distintos.'
          : '')
      );
    }
  );

  server.registerTool(
    'agents_running',
    {
      title: 'Ver agentes en ejecucion',
      description: 'Devuelve que agentes estan trabajando ahora mismo y el acumulado de la sesion.',
      inputSchema: {}
    },
    async () => {
      const live = Array.from(running.values()).map(
        (c) =>
          '  - ' + c.role + ' [' + c.providerLabel + ' / ' + c.model + '] ' +
          Math.round((Date.now() - c.startedAt) / 1000) + 's, ' + c.chars + ' caracteres'
      );

      const out = [
        'Agentes activos: ' + running.size,
        live.length ? live.join('\n') : '  (ninguno)',
        '',
        'Sesion: ' + stats.delegations + ' delegaciones, ' + stats.completed + ' ok, ' + stats.failed + ' fallidas',
        'Tokens movidos fuera de ' + JEFE + ': ' + stats.tokensIn + ' entrada / ' + stats.tokensOut + ' salida'
      ];
      return text(out.join('\n'));
    }
  );

  bus.connect();
  bus.send({ type: 'mcp.ready', providers: agentIds() });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // El SDK solo escucha datos y errores de stdin, no su cierre. Si el
  // orquestador muere sin cerrar bien (un crash, un kill), este proceso seguiria vivo para
  // siempre, sujeto por la conexion del bus. Que se vaya con su padre.
  const salir = () => {
    bus.close();
    process.exit(0);
  };
  process.stdin.on('end', salir);
  process.stdin.on('close', salir);
  bus.log('servidor MCP listo (pid ' + process.pid + ')');
}

main().catch((err) => {
  bus.log('fallo fatal: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
