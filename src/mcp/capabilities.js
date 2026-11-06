'use strict';

/**
 * Reparto del trabajo por capacidades.
 *
 * En vez de obligar al orquestador a recordar que modelo sirve para que, puede
 * pedir una capacidad ("codigo", "razonamiento") y aqui se resuelve contra el
 * catalogo vivo de los agentes que el usuario haya configurado, el estado de
 * salud de cada uno y las valoraciones de calidad que el propio orquestador ha
 * ido dejando.
 *
 * Las preferencias son patrones de MODELO, no de proveedor: el mismo Kimi o el
 * mismo gpt-oss pueden llegar por agentes distintos, y GCenter no sabe de
 * antemano cuales tendra cada usuario.
 *
 * Tres lecciones aprendidas en uso real dan forma a este modulo:
 *
 * 1. Resolver siempre al primer candidato es un error. Un lote de tres tareas
 *    de codigo acababa entero en el mismo modelo: si ese modelo escribe mal,
 *    las tres salen mal a la vez y el orquestador acaba rehaciendo todo. Por
 *    eso hay `candidatos()`, que devuelve una lista ordenada para repartir.
 *
 * 2. Lo que importa no es acertar con el mejor modelo, sino saber cuando NO
 *    queda ninguno: esa es la senal de que esa parte vuelve a manos del
 *    orquestador.
 *
 * 3. Un agente cuyo catalogo no casa con ningun patron conocido (un proveedor
 *    anadido a mano, por ejemplo) no puede quedarse sin trabajo: entra como
 *    generalista en todas las capacidades con su modelo mas reciente.
 */

const providers = require('./providers');
const health = require('./health');
const feedback = require('./feedback');

const CAPACIDADES = {
  codigo: {
    descripcion: 'Escribir, refactorizar y depurar codigo',
    // Ordenado por calidad de codigo, no por velocidad: un archivo mal escrito
    // que hay que rehacer cuesta mas que esperar unos segundos de mas
    patrones: [
      /kimi-k3/, /kimi-k2/, /deepseek-v4-pro/, /qwen3\.8/, /gpt-oss-120b/,
      /laguna-s/, /north-mini-code/, /starcoder/, /laguna/, /qwen3/, /devstral/, /coder/
    ]
  },

  razonamiento: {
    descripcion: 'Algoritmos, matematicas y analisis paso a paso',
    patrones: [
      /kimi-k3/, /deepseek-v4-pro/, /nemotron-3-ultra/, /gpt-oss-120b/, /qwen3\.8/,
      /reasoning/, /nex-n2\.5-pro/, /magistral/, /deepseek/
    ]
  },

  contextoLargo: {
    descripcion: 'Digerir archivos, documentos o repos enteros',
    patrones: [/^gemini-flash-latest$/, /^gemini-[\d.]+-flash$/, /kimi-k3/, /kimi-k2/, /ling-3\.0-flash/]
  },

  redaccion: {
    descripcion: 'Documentacion, resumenes, traduccion y texto para personas',
    patrones: [/mistral-small/, /ministral/, /^gemini-.*flash/, /palmyra-creative/, /gemma/]
  },

  rapido: {
    descripcion: 'Tareas triviales donde solo importa la latencia',
    patrones: [/gpt-oss-20b/, /qwen3\.6/, /flash-lite/, /lfm-2\.5/, /ministral-3b/, /mini/]
  },

  revision: {
    descripcion: 'Revisar de forma independiente el trabajo de otro agente',
    patrones: [/kimi-k3/, /nemotron-3-super/, /gpt-oss-120b/, /^gemini-.*flash$/, /nex-n2\.5-pro/]
  }
};

const NOMBRES = Object.keys(CAPACIDADES);
const TODOS_LOS_PATRONES = NOMBRES.flatMap((n) => CAPACIDADES[n].patrones);

/**
 * Un agente esta disponible si tiene llave, no esta agotado ni degradado, y su
 * catalogo le deja algun modelo utilizable con el filtro de gratuidad actual.
 */
function disponible(agent) {
  if (!agent.key) return false;
  if (health.estaAgotado(agent.id)) return false;
  if (health.nivel(agent.id) === 'degradado') return false;
  return true;
}

/** Modelos utilizables de cada agente disponible, consultados en paralelo. */
async function catalogos(excluir) {
  const agentes = providers.listAgents().filter((a) => !excluir.has(a.id) && disponible(a));
  const res = await Promise.all(
    agentes.map(async (a) => ({ agent: a, catalogo: await providers.fetchModels(a) }))
  );
  return res.filter((r) => r.catalogo.ok && r.catalogo.models.length);
}

/**
 * Todos los candidatos vivos para una capacidad, del mas al menos recomendable.
 *
 * El orden base es el de los patrones; encima se aplican las valoraciones del
 * orquestador, de modo que un modelo que ha rendido mal en este proyecto baja
 * puestos aunque sobre el papel fuera el favorito.
 *
 * @returns {Promise<Array<{provider, model, label}>>}
 */
async function candidatos(capacidad, opts) {
  const spec = CAPACIDADES[capacidad];
  if (!spec) {
    throw new Error('Capacidad "' + capacidad + '" desconocida. Disponibles: ' + NOMBRES.join(', '));
  }

  const excluir = new Set((opts && opts.excluir) || []);
  const excluirModelos = new Set((opts && opts.excluirModelos) || []);

  // Un cubo por agente con sus modelos aptos, en orden de patron. `mejor` es
  // la posicion del mejor patron que casa, para ordenar los agentes entre si.
  const cubos = [];
  for (const { agent, catalogo } of await catalogos(excluir)) {
    const cubo = { mejor: Infinity, items: [] };
    const vistos = new Set();

    const anadir = (model, pos) => {
      const k = agent.id + '|' + model;
      if (vistos.has(model) || excluirModelos.has(k) || feedback.vetado(agent.id, model)) return;
      vistos.add(model);
      cubo.items.push({ provider: agent.id, model, label: agent.label });
      cubo.mejor = Math.min(cubo.mejor, pos);
    };

    spec.patrones.forEach((patron, pos) => {
      const model = catalogo.models.find((m) => patron.test(m));
      if (model) anadir(model, pos);
    });

    // Generalista: su catalogo no se parece a nada conocido, asi que aporta su
    // modelo mas reciente a todas las capacidades, detras de los especialistas
    const conocido = catalogo.models.some((m) => TODOS_LOS_PATRONES.some((p) => p.test(m)));
    if (!conocido) anadir(catalogo.models[0], spec.patrones.length);

    if (cubo.items.length) cubos.push(cubo);
  }

  // Primero el agente con el modelo mas recomendable (sort es estable: en caso
  // de empate manda el orden en que el usuario los anadio)
  cubos.sort((a, b) => a.mejor - b.mejor);

  // Despues los intercalamos por rondas: el mejor de cada agente, luego el
  // segundo de cada uno, etc. Poner todos los de un agente seguidos hacia que
  // un lote de tres tareas cayera entero en el mismo sitio: misma cuota por
  // minuto y, si ese proveedor flojea, todo el lote flojea a la vez.
  const lista = [];
  let orden = 0;
  for (let ronda = 0; ; ronda++) {
    let alguno = false;
    for (const cubo of cubos) {
      if (cubo.items[ronda]) {
        lista.push(Object.assign({ orden: orden++ }, cubo.items[ronda]));
        alguno = true;
      }
    }
    if (!alguno) break;
  }

  // Las valoraciones mandan sobre el orden de fabrica, pero solo cuando hay
  // datos: sin valoraciones, el orden es el de los patrones
  lista.sort((a, b) => {
    const diff = feedback.puntuacion(b.provider, b.model) - feedback.puntuacion(a.provider, a.model);
    return diff || a.orden - b.orden;
  });

  return lista.map(({ provider, model, label }) => ({ provider, model, label }));
}

/** El mejor candidato, o null si nadie puede: entonces le toca al orquestador. */
async function resolver(capacidad, opts) {
  const lista = await candidatos(capacidad, opts);
  return lista[0] || null;
}

/**
 * Asigna ejecutores a un lote de tareas repartiendo entre modelos distintos.
 *
 * Si tres tareas piden "codigo", cada una va a un modelo diferente (mientras
 * haya donde elegir). Asi un modelo flojo no estropea el lote entero, se
 * reparten los limites de cuota por minuto, y el jefe puede comparar estilos.
 */
async function repartir(tareas) {
  const porCapacidad = new Map();
  const asignados = [];

  for (const t of tareas) {
    if (t.provider && t.model) {
      asignados.push({ provider: String(t.provider).toLowerCase(), model: t.model });
      continue;
    }
    if (!t.capability) {
      asignados.push(null);
      continue;
    }

    if (!porCapacidad.has(t.capability)) {
      porCapacidad.set(t.capability, { lista: await candidatos(t.capability), siguiente: 0 });
    }
    const c = porCapacidad.get(t.capability);
    if (!c.lista.length) {
      asignados.push(null);
      continue;
    }
    asignados.push(c.lista[c.siguiente % c.lista.length]);
    c.siguiente += 1;
  }

  return asignados;
}

/**
 * Estado de cobertura de todas las capacidades.
 * Lo que salga sin cubrir es trabajo que el orquestador tiene que asumir el mismo.
 */
async function cobertura() {
  const filas = [];
  for (const nombre of NOMBRES) {
    const lista = await candidatos(nombre);
    const primero = lista[0];
    filas.push({
      capacidad: nombre,
      descripcion: CAPACIDADES[nombre].descripcion,
      cubierta: Boolean(primero),
      opciones: lista.length,
      provider: primero ? primero.provider : null,
      label: primero ? primero.label : null,
      model: primero ? primero.model : null
    });
  }
  return filas;
}

module.exports = { CAPACIDADES, NOMBRES, candidatos, resolver, repartir, cobertura };
