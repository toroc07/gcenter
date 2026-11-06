'use strict';

/**
 * Agentes del usuario, plantillas de proveedores conocidos y politica de
 * gratuidad.
 *
 * GCenter no trae agentes de serie: cada persona anade los suyos con un nombre
 * y una API key de SU cuenta. Las PLANTILLAS solo sirven para reconocer a los
 * proveedores habituales (por el nombre o por el prefijo de la llave) y saber
 * su URL y que modelos suyos son gratis. Un proveedor que no reconocemos se
 * puede anadir igual indicando su URL base: basta con que hable la API de
 * OpenAI (/models y /chat/completions).
 *
 * Tres decisiones importantes viven aqui:
 *
 * 1. El catalogo se consulta SIEMPRE en vivo. Los ids de modelo caducan rapido
 *    (la lista gratuita de OpenRouter rota cada pocas semanas), asi que una
 *    lista escrita a mano en el codigo se queda obsoleta y manda a los agentes
 *    contra modelos que ya no existen. Los `fallbackModels` son solo el ultimo
 *    recurso para cuando el proveedor no responde.
 *
 * 2. Cada plantilla declara que considera gratis. Antes de cada delegacion se
 *    valida el modelo contra esa politica, para que nadie acabe pagando por
 *    tokens sin haberlo pedido.
 *
 * 3. Si la gratuidad de un agente no se puede comprobar (un proveedor
 *    desconocido que no publica precios), con el filtro de gratuidad activo
 *    ese agente no recibe trabajo. Es mejor no usarlo que arriesgar un cargo.
 */

/**
 * Modelos que no sirven para chat: embeddings, voz, video, musica, OCR,
 * moderacion, imagen. Aunque sean gratis no valen como agentes, y colarlos en
 * /chat/completions solo produce errores raros.
 */
const NON_CHAT = new RegExp(
  [
    // Texto que no es conversacion
    'embed', 'embedding', 'retriever', 'rerank', 'moderation', 'reward',
    'guard', 'content-safety', 'topic-control',
    // Voz
    '-tts', 'tts-', 'transcribe', 'whisper', 'voxtral', 'orpheus',
    'native-audio', 'realtime', '-live', 'live-', 'riva-',
    // Imagen y video
    'veo-', 'lyria', 'imagen', 'nano-banana', '-image', 'image-', 'diffusion',
    'video', 'nvclip', 'deplot', 'kosmos', 'fuyu', 'neva-', '/vila',
    // Documentos y otros usos especializados
    'ocr', 'parse', 'robotics', 'computer-use', 'aqa'
  ].join('|'),
  'i'
);

const PLANTILLAS = {
  groq: {
    id: 'groq',
    label: 'Groq',
    color: '#f55036',
    baseUrl: 'https://api.groq.com/openai/v1',
    alias: ['groq'],
    keyPrefix: 'gsk_',
    signupUrl: 'https://console.groq.com/keys',
    free: 'Gratis sin tarjeta - 30 req/min, 1.000 req/dia',
    strengths: 'Velocidad extrema (~300 tok/s). El mejor para generar codigo, refactors y tareas donde la latencia importa.',
    // Groq no deja gastar sin anadir una tarjeta: mientras la cuenta no tenga
    // metodo de pago, pasarse de la cuota devuelve 429, nunca una factura
    freePolicy: { mode: 'all' },
    fallbackModels: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']
  },

  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    color: '#4285f4',
    // Google expone una capa compatible con OpenAI sobre la Gemini API
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    alias: ['gemini', 'google', 'google ai', 'ai studio', 'aistudio'],
    keyPrefix: 'AIza',
    signupUrl: 'https://aistudio.google.com/apikey',
    free: 'Gratis sin tarjeta - ~10-15 req/min (solo modelos Flash y Gemma)',
    strengths: 'Ventana de hasta 1M de tokens. Imbatible para digerir archivos enormes, documentacion larga o repos completos.',
    // El catalogo de Google mezcla el tier gratuito con modelos de pago caros
    // (deep-research, Pro de ultima generacion, video, musica). Solo dejamos
    // pasar las familias que el tier gratuito cubre de verdad.
    freePolicy: {
      mode: 'allow',
      allow: [
        /^gemini-\d[\d.]*-flash(-lite)?(-preview)?$/,
        /^gemini-flash(-lite)?-latest$/,
        /^gemma-/,
        /^gemini-2\.5-pro$/
      ]
    },
    // El listado de Google devuelve ids con prefijo "models/"
    normalizeModelId: (id) => String(id).replace(/^models\//, ''),
    fallbackModels: ['gemini-flash-latest', 'gemini-flash-lite-latest']
  },

  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    color: '#8b5cf6',
    baseUrl: 'https://openrouter.ai/api/v1',
    alias: ['openrouter', 'open router'],
    keyPrefix: 'sk-or-',
    signupUrl: 'https://openrouter.ai/settings/keys',
    free: 'Gratis - unas 20 variantes :free - 50 req/dia sin creditos',
    strengths: 'Una sola llave para decenas de modelos abiertos. Ideal para lanzar varios especialistas distintos, o el mismo problema a dos modelos, y contrastar.',
    // OpenRouter publica el precio de cada modelo, asi que la comprobacion es
    // exacta: solo vale lo que cuesta cero de entrada Y de salida
    freePolicy: { mode: 'pricing' },
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/toroc07/gcenter',
      'X-Title': 'GCenter'
    },
    fallbackModels: []
  },

  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    color: '#76b900',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    alias: ['nvidia', 'nim', 'nvidia nim', 'build.nvidia'],
    keyPrefix: 'nvapi-',
    signupUrl: 'https://build.nvidia.com/',
    free: 'Gratis sin tarjeta - 1.000 creditos (~1 por llamada), ~40 req/min',
    strengths: 'El catalogo mas variado: Kimi K3, DeepSeek V4, Nemotron Ultra, modelos de vision y especialistas en finanzas, medicina y escritura creativa.',
    // NVIDIA no publica precios en su API y, sobre todo, no existe forma
    // autoservicio de asociar una tarjeta a build.nvidia.com: al acabarse los
    // creditos la API corta con un 402, nunca con un cargo. Por eso todo su
    // catalogo cuenta como gratuito, igual que en Groq.
    freePolicy: { mode: 'all' },
    fallbackModels: ['moonshotai/kimi-k3', 'nvidia/nemotron-3-super-120b-a12b']
  },

  mistral: {
    id: 'mistral',
    label: 'Mistral',
    color: '#ff7000',
    baseUrl: 'https://api.mistral.ai/v1',
    // Las llaves de Mistral no tienen prefijo propio: solo se reconoce por el nombre
    alias: ['mistral', 'mistral ai', 'la plateforme'],
    signupUrl: 'https://console.mistral.ai/api-keys',
    free: 'Gratis - tier Experiment (solo las familias Small y Ministral)',
    strengths: 'Modelos europeos rapidos. Muy buenos en resumen, traduccion y texto estructurado.',
    // Medium, Large, Codestral y Mistral Code son de pago en La Plateforme
    freePolicy: {
      mode: 'allow',
      allow: [/^mistral-small/, /^ministral-/, /^magistral-small/, /^open-/, /^devstral-small/, /^pixtral-12b/]
    },
    fallbackModels: ['mistral-small-latest', 'ministral-8b-latest']
  }
};

const KINDS = Object.keys(PLANTILLAS);

/** Colores para agentes de proveedores desconocidos, elegidos por su id. */
const COLORES_LIBRES = ['#9ca3af', '#a78bfa', '#38bdf8', '#f472b6', '#facc15', '#34d399', '#fb923c'];

function normalizarNombre(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Reconoce el proveedor de un agente nuevo a partir de su nombre o de su llave.
 * Devuelve el id de la plantilla, o null si no lo reconoce (entonces hace falta
 * que el usuario indique la URL base).
 */
function detectar(nombre, llave) {
  const n = normalizarNombre(nombre);
  if (n) {
    const palabras = n.split(/[\s\-_/.]+/);
    for (const p of Object.values(PLANTILLAS)) {
      if (p.alias.some((a) => n === a || n.startsWith(a + ' ') || palabras.includes(a))) {
        return p.id;
      }
    }
  }

  const k = String(llave || '').trim();
  if (k) {
    // El prefijo mas largo primero, para que uno corto no se adelante a otro
    // mas especifico que empiece igual
    const porPrefijo = Object.values(PLANTILLAS)
      .filter((p) => p.keyPrefix)
      .sort((a, b) => b.keyPrefix.length - a.keyPrefix.length)
      .find((p) => k.startsWith(p.keyPrefix));
    if (porPrefijo) return porPrefijo.id;
  }

  return null;
}

/** Convierte un nombre en un id corto y seguro: "Mi Groq #2" -> "mi-groq-2". */
function slug(nombre) {
  const base = String(nombre || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'agente';
}

/** Id que no choca con ninguno de los existentes. */
function idLibre(nombre, existentes) {
  const usados = new Set(existentes || []);
  const base = slug(nombre);
  if (!usados.has(base)) return base;
  for (let i = 2; ; i++) {
    if (!usados.has(base + '-' + i)) return base + '-' + i;
  }
}

/** Acepta la URL base con o sin barra final, o con el endpoint pegado. */
function normalizarUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|models)$/, '');
}

/**
 * Agente completo, listo para usar: la configuracion que guardo el usuario
 * mezclada con lo que sabemos de su proveedor.
 */
function resolverAgente(cfgAgente) {
  if (!cfgAgente || !cfgAgente.id) return null;
  const plantilla = PLANTILLAS[cfgAgente.kind];
  const id = String(cfgAgente.id);

  if (plantilla) {
    return Object.assign({}, plantilla, {
      id,
      kind: plantilla.id,
      label: cfgAgente.name || plantilla.label,
      providerLabel: plantilla.label,
      key: String(cfgAgente.key || '').trim(),
      custom: false
    });
  }

  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const baseUrl = normalizarUrl(cfgAgente.baseUrl);

  return {
    id,
    kind: 'custom',
    label: cfgAgente.name || id,
    providerLabel: 'Proveedor propio',
    color: COLORES_LIBRES[h % COLORES_LIBRES.length],
    key: String(cfgAgente.key || '').trim(),
    baseUrl,
    signupUrl: baseUrl,
    free: 'Proveedor anadido a mano',
    strengths: 'Proveedor compatible con OpenAI anadido por el usuario.',
    // Gratis solo si su catalogo publica precios y el modelo cuesta cero
    freePolicy: { mode: 'auto' },
    fallbackModels: [],
    custom: true
  };
}

/** Todos los agentes que el usuario ha configurado, ya resueltos. */
function listAgents() {
  return require('../shared/config').load().agents.map(resolverAgente).filter(Boolean);
}

/** Un agente por id. Lanza si no existe, con la lista de los que si. */
function getAgent(id) {
  const agentes = listAgents();
  const a = agentes.find((x) => x.id === String(id || '').trim());
  if (!a) {
    throw new Error(
      'Agente "' + id + '" desconocido. ' +
      (agentes.length
        ? 'Configurados: ' + agentes.map((x) => x.id).join(', ') + '.'
        : 'El usuario no tiene ningun agente configurado.')
    );
  }
  return a;
}

/** Plantillas para la interfaz: que proveedores se reconocen solos. */
function listPlantillas() {
  return Object.values(PLANTILLAS).map((p) => ({
    id: p.id,
    label: p.label,
    color: p.color,
    signupUrl: p.signupUrl,
    free: p.free,
    keyPrefix: p.keyPrefix || ''
  }));
}

function authHeaders(agent) {
  return Object.assign(
    {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + agent.key
    },
    agent.extraHeaders || {}
  );
}

function filtroGratisActivo() {
  return require('../shared/config').load().freeOnly !== false;
}

/* ------------------------------------------------------------------ *
 * Catalogo en vivo, con cache corta
 * ------------------------------------------------------------------ */

const CATALOG_TTL_MS = 10 * 60 * 1000;
// agentId -> { at, ok, error, raw }. Se guarda el listado en crudo y el filtro
// se aplica en cada consulta: asi activar o desactivar el filtro de gratuidad
// surte efecto al momento, sin esperar a que caduque la cache.
const catalogCache = new Map();

/**
 * Modelos que el catalogo anuncia pero que al usarlos resulta que estan
 * restringidos (OpenRouter reserva algunos de sus modelos gratuitos a
 * aplicaciones de su directorio, y no lo indica en ningun campo). Cuando uno
 * nos rechaza asi, lo apuntamos y dejamos de ofrecerlo.
 */
const restringidos = new Set(require('../shared/config').load().restrictedModels || []);

function marcarRestringido(agentId, model) {
  const clave = agentId + '|' + model;
  if (restringidos.has(clave)) return;

  restringidos.add(clave);

  // Lo recordamos entre sesiones: si no, cada arranque vuelve a tropezar con
  // el mismo modelo restringido y gasta una delegacion en descubrirlo
  try {
    require('../shared/config').save({ restrictedModels: [...restringidos] });
  } catch (e) {
    /* si no se puede guardar, al menos vale para esta sesion */
  }
}

function estaRestringido(agentId, model) {
  return restringidos.has(agentId + '|' + model);
}

/**
 * La politica 'auto' (proveedores anadidos a mano) solo puede verificar la
 * gratuidad si el catalogo publica precios. Si ningun modelo trae `pricing`,
 * no hay forma de saber si cobra.
 */
function publicaPrecios(raw) {
  return raw.some((m) => m && m.pricing && m.pricing.prompt !== undefined);
}

/** Si la gratuidad de este agente se puede comprobar con su catalogo. */
function gratuidadVerificable(agent, raw) {
  if (agent.freePolicy.mode !== 'auto') return true;
  return publicaPrecios(raw || []);
}

/** Pide el catalogo al proveedor (o lo saca de la cache). */
async function catalogoCrudo(agent, opts) {
  const options = opts || {};
  const cached = catalogCache.get(agent.id);
  if (!options.force && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 20000);

  let entrada;
  try {
    const res = await fetch(agent.baseUrl + '/models', { headers: authHeaders(agent), signal: ctrl.signal });
    if (!res.ok) {
      entrada = {
        ok: false,
        error: res.status === 401 ? 'llave invalida (HTTP 401)' : 'HTTP ' + res.status,
        raw: []
      };
    } else {
      const json = await res.json();
      const lista = Array.isArray(json) ? json : json.data || json.models || [];
      const raw = lista.map((m) =>
        Object.assign({}, m, {
          id: agent.normalizeModelId ? agent.normalizeModelId(m.id || m.name) : String(m.id || m.name || '')
        })
      );
      entrada = { ok: true, raw };
    }
  } catch (err) {
    // "fetch failed" no le dice nada a nadie: casi siempre es una URL mal
    // escrita, un servidor caido o la red cortada
    const error = err.name === 'AbortError'
      ? 'no respondio a tiempo'
      : /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(String(err.message) + String(err.cause && err.cause.code))
        ? 'no se pudo conectar con ' + agent.baseUrl
        : err.message;
    entrada = { ok: false, error, raw: [] };
  } finally {
    clearTimeout(timer);
  }

  entrada.at = Date.now();
  // Los fallos no se guardan: el siguiente intento vuelve a preguntar
  if (entrada.ok) catalogCache.set(agent.id, entrada);
  return entrada;
}

/**
 * Modelos que este agente puede usar ahora mismo.
 *
 * Con el filtro de gratuidad activo, solo los gratuitos verificados; sin el,
 * todos los de chat. `bloqueado` indica que el filtro deja al agente sin
 * ningun modelo porque su gratuidad no se puede comprobar.
 */
async function fetchModels(agent, opts) {
  const options = opts || {};
  const soloGratis = options.freeOnly !== undefined ? options.freeOnly : filtroGratisActivo();

  if (!agent.key) {
    return { ok: false, error: 'sin API key', models: [], raw: [], freeCount: 0, verificable: true };
  }
  if (!agent.baseUrl) {
    return { ok: false, error: 'sin URL base', models: [], raw: [], freeCount: 0, verificable: true };
  }

  const cat = await catalogoCrudo(agent, options);
  if (!cat.ok) {
    return {
      ok: false,
      error: cat.error,
      models: agent.fallbackModels.slice(),
      raw: [],
      freeCount: 0,
      verificable: true
    };
  }

  const verificable = gratuidadVerificable(agent, cat.raw);
  const vivos = (m) => m.id && !NON_CHAT.test(m.id) && !estaRestringido(agent.id, m.id);

  const gratis = verificable
    ? cat.raw.filter((m) => vivos(m) && isFreeEntry(agent, m, cat.raw)).map((m) => m.id).sort(byFreshness)
    : [];
  const todos = cat.raw.filter(vivos).map((m) => m.id).sort(byFreshness);

  let models;
  if (soloGratis) {
    models = gratis.length || !verificable ? gratis : agent.fallbackModels.slice();
  } else {
    models = todos.length ? todos : agent.fallbackModels.slice();
  }

  return {
    ok: true,
    models,
    raw: cat.raw,
    totalSeen: cat.raw.length,
    freeCount: gratis.length,
    verificable,
    bloqueado: soloGratis && !verificable
  };
}

/**
 * Ordena los modelos de mas a menos recomendable.
 *
 * Los catalogos incluyen versiones viejas que el proveedor ya no sirve a
 * cuentas nuevas, y quien lea la lista tiende a coger de arriba. Asi que
 * primero van los alias `-latest`, que siempre apuntan a algo vivo, y despues
 * las versiones mas altas primero.
 */
function byFreshness(a, b) {
  const aLatest = /-latest$/.test(a);
  const bLatest = /-latest$/.test(b);
  if (aLatest !== bLatest) return aLatest ? -1 : 1;

  // Comparacion natural: "gemini-3.10" tiene que quedar por encima de "gemini-3.8"
  return b.localeCompare(a, 'en', { numeric: true });
}

/** Decide si una entrada del catalogo es gratis y chateable. */
function isFreeEntry(agent, entry, raw) {
  const id = String(entry.id || '');
  if (!id || NON_CHAT.test(id)) return false;

  const policy = agent.freePolicy;

  if (policy.mode === 'pricing' || policy.mode === 'auto') {
    if (policy.mode === 'auto' && raw && !publicaPrecios(raw)) return false;
    const pr = entry.pricing;
    if (!pr) return false;
    return Number(pr.prompt) === 0 && Number(pr.completion) === 0;
  }

  if (policy.mode === 'allow') {
    return pasaListaBlanca(policy, id);
  }

  return true; // mode 'all'
}

/** Esta en la lista blanca y no en la de exclusiones. */
function pasaListaBlanca(policy, id) {
  if (policy.deny && policy.deny.some((re) => re.test(id))) return false;
  return policy.allow.some((re) => re.test(id));
}

/**
 * Comprueba que un modelo concreto se puede usar sin pagar.
 * Devuelve `{ ok }` o `{ ok: false, reason, alternatives }`.
 */
async function checkFree(agent, model) {
  const id = String(model || '');

  if (estaRestringido(agent.id, id)) {
    const catalog = await fetchModels(agent, { freeOnly: true });
    return {
      ok: false,
      reason: 'ese modelo esta restringido por ' + agent.label + ' y ya fallo antes',
      alternatives: catalog.models.slice(0, 12)
    };
  }

  if (NON_CHAT.test(id)) {
    return {
      ok: false,
      reason: 'no es un modelo de chat (parece de voz, imagen, embeddings u OCR)',
      alternatives: []
    };
  }

  // Para politicas por patron basta con el patron: no hace falta ni red
  if (agent.freePolicy.mode === 'allow' && pasaListaBlanca(agent.freePolicy, id)) {
    return { ok: true };
  }
  if (agent.freePolicy.mode === 'all') {
    return { ok: true };
  }

  // El resto se decide contra el catalogo en vivo
  const catalog = await fetchModels(agent, { freeOnly: true });
  if (catalog.ok && !catalog.verificable) {
    return {
      ok: false,
      reason:
        'no se puede comprobar si ' + agent.label + ' cobra por ese modelo (su catalogo no publica ' +
        'precios). Con el filtro de gratuidad activo, este agente no se usa',
      alternatives: []
    };
  }
  if (catalog.models.includes(id)) return { ok: true };

  return {
    ok: false,
    reason:
      agent.freePolicy.mode === 'allow'
        ? 'ese modelo de ' + agent.label + ' no esta en el tier gratuito'
        : 'ese modelo de ' + agent.label + ' cobra por token',
    alternatives: catalog.models.slice(0, 12)
  };
}

/* ------------------------------------------------------------------ *
 * Inferencia
 * ------------------------------------------------------------------ */

/** Codigos que suelen ser pasajeros: saturacion o limite de cuota por minuto. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Una sola ronda de chat contra cualquier proveedor.
 * `onDelta` recibe cada fragmento de texto para poder pintar progreso en vivo.
 */
async function chat(opts) {
  const {
    agent,
    model,
    system,
    prompt,
    temperature = 0.3,
    maxTokens = 4096,
    timeoutMs = 180000,
    onDelta
  } = opts;

  // `provider` sigue siendo el nombre que usan los mensajes de error de abajo
  const provider = agent;
  if (!agent || !agent.key) {
    throw new Error(
      'LLAVE INVALIDA: el agente ' + (agent ? agent.label : '?') + ' no tiene API key. ' +
      'Anadela en la ventana de agentes de GCenter.'
    );
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = Date.now();

  /** Hace UNA peticion y consume su stream. No lanza por codigos de error. */
  async function once(useModel, budget) {
    const post = (extras) =>
      fetch(agent.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: authHeaders(agent),
        signal: ctrl.signal,
        body: JSON.stringify(
          Object.assign(
            { model: useModel, messages, temperature, max_tokens: budget, stream: true },
            extras
          )
        )
      });

    // stream_options nos da el recuento de tokens, pero no todos los
    // proveedores compatibles con OpenAI lo aceptan: si lo rechazan,
    // repetimos sin el y nos quedamos sin contador en vez de sin respuesta
    let res = await post({ stream_options: { include_usage: true } });
    if (res.status === 400) res = await post({});

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        body: await res.text().catch(() => ''),
        // Cuando el proveedor dice cuanto esperar, le hacemos caso en vez de
        // inventarnos un tiempo de espera
        retryAfter: Number(res.headers.get('retry-after')) || null
      };
    }

    let text = '';
    let reasoning = '';
    let usage = null;
    let finishReason = null;

    for await (const chunk of iterateSSE(res.body)) {
      const choice = chunk && chunk.choices && chunk.choices[0];
      const delta = choice && choice.delta;

      if (delta && delta.content) {
        text += delta.content;
        if (onDelta) onDelta(delta.content, text, { reasoningChars: reasoning.length });
      }

      // Los modelos de razonamiento mandan su cadena de pensamiento por un
      // campo aparte (`reasoning` en Groq y OpenRouter, `reasoning_content` en
      // los de estilo DeepSeek). Sin esto parecen colgados: gastan tokens
      // durante minutos sin que el contador de la interfaz se mueva.
      const piensa = delta && (delta.reasoning || delta.reasoning_content);
      if (piensa) {
        reasoning += piensa;
        if (onDelta) {
          onDelta('', text, { reasoningChars: reasoning.length, thinking: !text });
        }
      }

      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
      if (chunk && chunk.usage) usage = chunk.usage;
    }

    return { ok: true, status: 200, text: text.trim(), reasoning, usage, finishReason };
  }

  try {
    let usedModel = model;
    let budget = maxTokens;
    let r = await once(usedModel, budget);

    // Los catalogos siguen anunciando modelos que el proveedor ya no sirve a
    // cuentas nuevas. Cuando pasa, el propio error dice cual es el sustituto:
    // lo aprovechamos y reintentamos una vez en lugar de fallar la delegacion.
    if (!r.ok && r.status === 404) {
      const suggested = (r.body.match(/use\s+(?:models\/)?([\w.\-]+\/?[\w.:\-]*)/i) || [])[1];
      const candidate = suggested ? suggested.replace(/^models\//, '') : null;

      // El sustituto que propone el proveedor tambien tiene que ser gratis:
      // seguir su recomendacion a ciegas seria saltarse la barrera
      const swapOk = candidate && candidate !== model &&
        (!filtroGratisActivo() || (await checkFree(agent, candidate)).ok);

      if (swapOk) {
        usedModel = candidate;
        r = await once(usedModel, budget);
      } else {
        // Sin sustituto: el modelo figura en el catalogo pero no esta servido.
        // NVIDIA, por ejemplo, lista modelos cuyo endpoint devuelve "Function
        // not found". Lo apartamos para siempre y que la tarea vaya a otro.
        marcarRestringido(provider.id, usedModel);
        throw new Error(
          'MODELO NO DISPONIBLE: ' + provider.label + ' anuncia ' + usedModel + ' en su catalogo pero ' +
          'no lo sirve (404). Queda apartado del reparto.'
        );
      }
    }

    // Las cuotas gratuitas se saturan con facilidad. Un par de reintentos con
    // espera creciente convierte la mayoria de estos fallos en exitos.
    for (let intento = 0; !r.ok && RETRYABLE.has(r.status) && intento < 2; intento++) {
      const espera = r.retryAfter ? Math.min(r.retryAfter * 1000, 20000) : 1500 * (intento + 1);
      await sleep(espera);
      r = await once(usedModel, budget);
    }

    if (!r.ok) {
      // 402 es como NVIDIA avisa de que se agotaron los creditos gratuitos.
      // No es un cargo: es un corte. Merece un mensaje que se entienda.
      if (r.status === 402) {
        throw new Error(
          'SIN CREDITOS: se agotaron los creditos gratuitos de ' + provider.label + '. No se te ha cobrado nada: ' +
          'el servicio simplemente deja de responder. Puedes pedir mas en ' + provider.signupUrl +
          ' o delegar en otro proveedor.'
        );
      }
      // Algunos modelos gratuitos estan reservados a aplicaciones del
      // directorio del proveedor. No se puede saber de antemano, asi que lo
      // aprendemos aqui y dejamos de ofrecerlo.
      if (r.status === 403 && /agentic harness|only available/i.test(r.body)) {
        marcarRestringido(provider.id, usedModel);
        throw new Error(
          'El modelo ' + usedModel + ' es gratuito pero ' + provider.label + ' lo reserva a ' +
          'aplicaciones de su directorio. Lo he retirado de la lista; vuelve a delegar con otro.'
        );
      }

      /*
       * Un 403 NO significa "llave invalida" (eso es el 401), y tratarlo asi
       * llevaba a diagnosticos falsos. En la practica nos hemos encontrado:
       *   - Groq bloqueando la IP de una VPN ("check your network settings")
       *   - OpenCode reservando su capa gratuita a su propia app (FreeTierError)
       * Ninguno es culpa de la llave ni de la tarea: hay que decirlo claro y
       * dejar que la tarea vaya a otro proveedor.
       */
      if (r.status === 403) {
        if (/network settings|access denied/i.test(r.body)) {
          throw new Error(
            'RED BLOQUEADA: ' + provider.label + ' rechaza la conexion desde tu red. Suele ser una VPN ' +
            'activa; la llave no tiene la culpa.'
          );
        }
        throw new Error(
          'ACCESO DENEGADO: ' + provider.label + ' no permite este uso de su capa gratuita (' +
          r.body.replace(/\s+/g, ' ').slice(0, 200) + ').'
        );
      }

      if (r.status === 401) {
        throw new Error(
          'LLAVE INVALIDA: ' + provider.label + ' no reconoce la API key. Revisala en Ajustes ' +
          '(se consigue en ' + provider.signupUrl + ').'
        );
      }

      // Un 429 que sobrevive a los reintentos no es saturacion pasajera: es
      // que la cuota gratuita esta agotada o el tier no esta activado
      if (r.status === 429) {
        throw new Error(
          'Cuota de ' + provider.label + ' agotada (sigue devolviendo 429 tras varios reintentos). ' +
          'No hay cargo alguno. Delega en otro proveedor, o revisa tu cuenta en ' + provider.signupUrl +
          ' por si el tier gratuito necesita activarse.'
        );
      }

      throw new Error(provider.label + ' devolvio HTTP ' + r.status + ': ' + r.body.slice(0, 400));
    }

    // Un modelo de razonamiento puede gastarse TODO el presupuesto pensando y
    // devolver una respuesta vacia. Como eso es indistinguible de un exito,
    // le damos una segunda oportunidad con margen de sobra.
    if (!r.text && r.reasoning && r.finishReason === 'length') {
      budget = Math.min(Math.max(budget * 4, 2048), 16000);
      const conMargen = await once(usedModel, budget);
      if (conMargen.ok && conMargen.text) r = conMargen;
    }

    if (!r.text) {
      throw new Error(
        r.reasoning
          ? 'El modelo ' + usedModel + ' agoto su presupuesto de tokens razonando y no llego a ' +
            'responder. Vuelve a delegar subiendo max_tokens, o usa un modelo sin cadena de ' +
            'pensamiento para tareas cortas.'
          : provider.label + ' devolvio una respuesta vacia (finish_reason: ' + r.finishReason + ').'
      );
    }

    return {
      text: r.text,
      reasoningChars: r.reasoning.length,
      // El control de calidad lo necesita para saber si la respuesta quedo
      // cortada a mitad o termino por voluntad del modelo
      finishReason: r.finishReason,
      usage: r.usage || {},
      elapsedMs: Date.now() - startedAt,
      provider: agent.id,
      model: usedModel,
      // Avisamos si acabamos usando otro modelo, para que se vea en el sidebar
      substituted: usedModel !== model ? model : null
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(provider.label + ' no respondio en ' + Math.round(timeoutMs / 1000) + 's (timeout)');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Lee un stream SSE de OpenAI y va soltando cada objeto JSON ya parseado. */
async function* iterateSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);

      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        yield JSON.parse(payload);
      } catch (e) {
        // Fragmento partido entre chunks: el siguiente lo trae entero
      }
    }
  }
}

module.exports = {
  PLANTILLAS,
  KINDS,
  NON_CHAT,
  detectar,
  idLibre,
  normalizarUrl,
  resolverAgente,
  listAgents,
  getAgent,
  listPlantillas,
  fetchModels,
  checkFree,
  byFreshness,
  chat,
  // Para las pruebas
  _catalogCache: catalogCache
};
