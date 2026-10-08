'use strict';

/**
 * Catalogo de proveedores de IA gratuitos y politica de gratuidad.
 *
 * Todos exponen (o emulan) la API de OpenAI /chat/completions, asi que un solo
 * cliente los cubre a todos. Lo unico que cambia entre ellos es la baseUrl, la
 * cabecera de autenticacion y como se listan los modelos.
 *
 * Dos decisiones importantes viven aqui:
 *
 * 1. El catalogo se consulta SIEMPRE en vivo. Los ids de modelo caducan rapido
 *    (la lista gratuita de OpenRouter rota cada pocas semanas), asi que una
 *    lista escrita a mano en el codigo se queda obsoleta y manda a los agentes
 *    contra modelos que ya no existen. Los `fallbackModels` son solo el ultimo
 *    recurso para cuando el proveedor no responde.
 *
 * 2. Cada proveedor declara que considera gratis. Antes de cada delegacion se
 *    valida el modelo contra esa politica, para que nadie acabe pagando por
 *    tokens sin haberlo pedido.
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

const PROVIDERS = {
  groq: {
    id: 'groq',
    label: 'Groq',
    color: '#f55036',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyName: 'GROQ_API_KEY',
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
    keyName: 'GEMINI_API_KEY',
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
    keyName: 'OPENROUTER_API_KEY',
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
    keyName: 'NVIDIA_API_KEY',
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
    keyName: 'MISTRAL_API_KEY',
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

const PROVIDER_IDS = Object.keys(PROVIDERS);

function getProvider(id) {
  const p = PROVIDERS[String(id || '').toLowerCase()];
  if (!p) {
    throw new Error(
      'Proveedor "' + id + '" desconocido. Disponibles: ' + PROVIDER_IDS.join(', ')
    );
  }
  return p;
}

function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    color: p.color,
    keyName: p.keyName,
    signupUrl: p.signupUrl,
    free: p.free,
    strengths: p.strengths
  }));
}

function authHeaders(provider, apiKey) {
  return Object.assign(
    {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey
    },
    provider.extraHeaders || {}
  );
}

/* ------------------------------------------------------------------ *
 * Catalogo en vivo, con cache corta
 * ------------------------------------------------------------------ */

const CATALOG_TTL_MS = 10 * 60 * 1000;
const catalogCache = new Map(); // providerId -> { at, result }

/**
 * Modelos que el catalogo anuncia pero que al usarlos resulta que estan
 * restringidos (OpenRouter reserva algunos de sus modelos gratuitos a
 * aplicaciones de su directorio, y no lo indica en ningun campo). Cuando uno
 * nos rechaza asi, lo apuntamos y dejamos de ofrecerlo en esta sesion.
 */
const restringidos = new Set(require('../shared/config').load().restrictedModels || []);

function marcarRestringido(providerId, model) {
  const clave = providerId + '|' + model;
  if (restringidos.has(clave)) return;

  restringidos.add(clave);
  catalogCache.delete(providerId); // que el proximo listado ya no lo incluya

  // Lo recordamos entre sesiones: si no, cada arranque vuelve a tropezar con
  // el mismo modelo restringido y gasta una delegacion en descubrirlo
  try {
    require('../shared/config').save({ restrictedModels: [...restringidos] });
  } catch (e) {
    /* si no se puede guardar, al menos vale para esta sesion */
  }
}

function estaRestringido(providerId, model) {
  return restringidos.has(providerId + '|' + model);
}

/**
 * Pide al proveedor su catalogo y devuelve solo los modelos que son gratis y
 * sirven para chatear. `raw` trae el listado completo por si hace falta
 * explicar que se ha descartado.
 */
async function fetchModels(providerId, apiKey, opts) {
  const options = opts || {};
  const timeoutMs = options.timeoutMs || 20000;
  const provider = getProvider(providerId);

  if (!apiKey) {
    return { ok: false, error: 'sin API key', models: provider.fallbackModels, raw: [] };
  }

  const cached = catalogCache.get(providerId);
  if (!options.force && cached && Date.now() - cached.at < CATALOG_TTL_MS) {
    return cached.result;
  }

  const url = provider.baseUrl + '/models';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { headers: authHeaders(provider, apiKey), signal: ctrl.signal });
    if (!res.ok) {
      return { ok: false, error: 'HTTP ' + res.status, models: provider.fallbackModels, raw: [] };
    }

    const json = await res.json();
    const raw = (json.data || []).map((m) =>
      Object.assign({}, m, {
        id: provider.normalizeModelId ? provider.normalizeModelId(m.id) : m.id
      })
    );

    const models = raw
      .filter((m) => isFreeEntry(provider, m))
      .map((m) => m.id)
      .filter((id) => !estaRestringido(providerId, id))
      .sort(byFreshness);

    const result = {
      ok: true,
      models: models.length ? models : provider.fallbackModels,
      raw,
      totalSeen: raw.length
    };
    catalogCache.set(providerId, { at: Date.now(), result });
    return result;
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? 'timeout' : err.message,
      models: provider.fallbackModels,
      raw: []
    };
  } finally {
    clearTimeout(timer);
  }
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
function isFreeEntry(provider, entry) {
  const id = String(entry.id || '');
  if (!id || NON_CHAT.test(id)) return false;

  const policy = provider.freePolicy;

  if (policy.mode === 'pricing') {
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
async function checkFree(providerId, model, apiKey) {
  const provider = getProvider(providerId);
  const id = String(model || '');

  if (estaRestringido(providerId, id)) {
    const catalog = await fetchModels(providerId, apiKey);
    return {
      ok: false,
      reason: 'ese modelo esta restringido por ' + provider.label + ' y ya fallo antes',
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
  if (provider.freePolicy.mode === 'allow' && pasaListaBlanca(provider.freePolicy, id)) {
    return { ok: true };
  }
  if (provider.freePolicy.mode === 'all') {
    return { ok: true };
  }

  // El resto se decide contra el catalogo en vivo
  const catalog = await fetchModels(providerId, apiKey);
  if (catalog.models.includes(id)) return { ok: true };

  return {
    ok: false,
    reason:
      provider.freePolicy.mode === 'pricing'
        ? 'ese modelo de ' + provider.label + ' cobra por token'
        : 'ese modelo de ' + provider.label + ' no esta en el tier gratuito',
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
    providerId,
    apiKey,
    model,
    system,
    prompt,
    temperature = 0.3,
    maxTokens = 4096,
    timeoutMs = 180000,
    onDelta
  } = opts;

  const provider = getProvider(providerId);
  if (!apiKey) {
    throw new Error(
      'Falta la API key de ' + provider.label + '. Consiguela gratis en ' + provider.signupUrl +
      ' y pegala en Ajustes de GCenter (o exporta ' + provider.keyName + ').'
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
      fetch(provider.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: authHeaders(provider, apiKey),
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
        (await checkFree(provider.id, candidate, apiKey)).ok;

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
      provider: provider.id,
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
  PROVIDERS,
  PROVIDER_IDS,
  NON_CHAT,
  listProviders,
  getProvider,
  fetchModels,
  checkFree,
  chat
};
