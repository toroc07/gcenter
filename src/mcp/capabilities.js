'use strict';

/**
 * Reparto del trabajo por capacidades.
 *
 * En vez de obligar al jefe a recordar que modelo sirve para que, puede pedir
 * una capacidad ("codigo", "razonamiento") y aqui se resuelve contra el
 * catalogo vivo, el estado de salud de cada proveedor y las valoraciones de
 * calidad que el propio jefe ha ido dejando.
 *
 * Dos lecciones aprendidas en uso real dan forma a este modulo:
 *
 * 1. Resolver siempre al primer candidato es un error. Un lote de tres tareas
 *    de codigo acababa entero en el mismo modelo: si ese modelo escribe mal,
 *    las tres salen mal a la vez y el jefe acaba rehaciendo todo. Por eso hay
 *    `candidatos()`, que devuelve una lista ordenada para repartir.
 *
 * 2. Lo que importa no es acertar con el mejor modelo, sino saber cuando NO
 *    queda ninguno: esa es la senal de que esa parte vuelve a manos de Claude.
 */

const providers = require('./providers');
const health = require('./health');
const feedback = require('./feedback');
const config = require('../shared/config');

const CAPACIDADES = {
  codigo: {
    descripcion: 'Escribir, refactorizar y depurar codigo',
    // Ordenado por calidad de codigo, no por velocidad: un archivo mal escrito
    // que hay que rehacer cuesta mas que esperar unos segundos de mas
    preferencias: [
      { provider: 'nvidia', patrones: [/kimi-k3/, /kimi-k2/, /deepseek-v4-pro/, /starcoder/] },
      { provider: 'groq', patrones: [/qwen3\.8/, /gpt-oss-120b/, /qwen3/] },
      { provider: 'openrouter', patrones: [/laguna-s/, /north-mini-code/, /laguna/] },
    ]
  },

  razonamiento: {
    descripcion: 'Algoritmos, matematicas y analisis paso a paso',
    preferencias: [
      { provider: 'nvidia', patrones: [/kimi-k3/, /deepseek-v4-pro/, /nemotron-3-ultra/] },
      { provider: 'groq', patrones: [/gpt-oss-120b/, /qwen3\.8/] },
      { provider: 'openrouter', patrones: [/nemotron-3-ultra/, /reasoning/, /nex-n2\.5-pro/] }
    ]
  },

  contextoLargo: {
    descripcion: 'Digerir archivos, documentos o repos enteros',
    preferencias: [
      { provider: 'gemini', patrones: [/^gemini-flash-latest$/, /flash$/] },
      { provider: 'nvidia', patrones: [/kimi-k3/, /kimi-k2/] },
      { provider: 'openrouter', patrones: [/ling-3\.0-flash/] }
    ]
  },

  redaccion: {
    descripcion: 'Documentacion, resumenes, traduccion y texto para personas',
    preferencias: [
      { provider: 'mistral', patrones: [/mistral-small/, /ministral/] },
      { provider: 'gemini', patrones: [/flash/] },
      { provider: 'nvidia', patrones: [/palmyra-creative/, /gemma/] },
      { provider: 'openrouter', patrones: [/gemma/] }
    ]
  },

  rapido: {
    descripcion: 'Tareas triviales donde solo importa la latencia',
    preferencias: [
      { provider: 'groq', patrones: [/gpt-oss-20b/, /qwen3\.6/] },
      { provider: 'gemini', patrones: [/flash-lite/] },
      { provider: 'openrouter', patrones: [/lfm-2\.5/, /mini/] }
    ]
  },

  revision: {
    descripcion: 'Revisar de forma independiente el trabajo de otro agente',
    preferencias: [
      { provider: 'nvidia', patrones: [/kimi-k3/, /nemotron-3-super/] },
      { provider: 'groq', patrones: [/gpt-oss-120b/] },
      { provider: 'gemini', patrones: [/flash$/] },
      { provider: 'openrouter', patrones: [/nex-n2\.5-pro/] }
    ]
  }
};

const NOMBRES = Object.keys(CAPACIDADES);

/** Un proveedor esta disponible si tiene llave y no esta agotado ni degradado. */
function disponible(providerId) {
  if (health.estaAgotado(providerId)) return false;
  if (health.nivel(providerId) === 'degradado') return false;
  const meta = providers.getProvider(providerId);
  return Boolean(config.apiKeyFor(providerId, meta.keyName));
}

/**
 * Todos los candidatos vivos para una capacidad, del mas al menos recomendable.
 *
 * El orden base es el de las preferencias; encima se aplican las valoraciones
 * del jefe, de modo que un modelo que ha rendido mal en este proyecto baja
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
  const vistos = new Set();

  // Primero, los modelos aptos de cada proveedor, en orden de preferencia
  const porProveedor = new Map();
  for (const pref of spec.preferencias) {
    if (excluir.has(pref.provider) || !disponible(pref.provider)) continue;

    const meta = providers.getProvider(pref.provider);
    const catalogo = await providers.fetchModels(pref.provider, config.apiKeyFor(pref.provider, meta.keyName));
    if (!catalogo.ok || !catalogo.models.length) continue;

    if (!porProveedor.has(pref.provider)) porProveedor.set(pref.provider, []);
    const cubo = porProveedor.get(pref.provider);

    for (const patron of pref.patrones) {
      const model = catalogo.models.find((m) => patron.test(m));
      if (!model) continue;

      const k = pref.provider + '|' + model;
      if (vistos.has(k) || excluirModelos.has(k)) continue;
      if (feedback.vetado(pref.provider, model)) continue;

      vistos.add(k);
      cubo.push({ provider: pref.provider, model, label: meta.label });
    }
  }

  // Despues los intercalamos por rondas: el mejor de cada proveedor, luego el
  // segundo de cada uno, etc. Poner todos los de un proveedor seguidos hacia
  // que un lote de tres tareas cayera entero en el mismo sitio: misma cuota
  // por minuto y, si ese proveedor flojea, todo el lote flojea a la vez.
  const lista = [];
  let orden = 0;
  for (let ronda = 0; ; ronda++) {
    let alguno = false;
    for (const cubo of porProveedor.values()) {
      if (cubo[ronda]) {
        lista.push(Object.assign({ orden: orden++ }, cubo[ronda]));
        alguno = true;
      }
    }
    if (!alguno) break;
  }

  // Las valoraciones mandan sobre el orden de fabrica, pero solo cuando hay
  // datos: sin valoraciones, el orden es el de las preferencias
  lista.sort((a, b) => {
    const diff = feedback.puntuacion(b.provider, b.model) - feedback.puntuacion(a.provider, a.model);
    return diff || a.orden - b.orden;
  });

  return lista.map(({ provider, model, label }) => ({ provider, model, label }));
}

/** El mejor candidato, o null si nadie puede: entonces le toca a Claude. */
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
 * Lo que salga sin cubrir es trabajo que Claude tiene que asumir el mismo.
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
