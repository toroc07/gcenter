'use strict';

/**
 * Sonda de alcanzabilidad.
 *
 * Groq bloquea segun la IP de origen, asi que una lista de proveedores "gratis"
 * no sirve de nada si tu red no llega a ellos. Esto prueba cada endpoint sin
 * credenciales y traduce el codigo de respuesta:
 *
 *   401 / 403 "invalid api key"  -> el servicio responde: ALCANZABLE
 *   200                          -> responde y ni siquiera pide llave
 *   403 con mensaje de red       -> BLOQUEADO para esta red
 *   fallo de DNS o timeout       -> INALCANZABLE
 *
 * No usa ninguna API key y no genera tokens.
 */

const CANDIDATOS = [
  { id: 'groq',       label: 'Groq',                url: 'https://api.groq.com/openai/v1/models' },
  { id: 'gemini',     label: 'Google Gemini',       url: 'https://generativelanguage.googleapis.com/v1beta/openai/models' },
  { id: 'openrouter', label: 'OpenRouter',          url: 'https://openrouter.ai/api/v1/models' },
  { id: 'mistral',    label: 'Mistral',             url: 'https://api.mistral.ai/v1/models' },
  { id: 'cerebras',   label: 'Cerebras',            url: 'https://api.cerebras.ai/v1/models' },
  { id: 'nvidia',     label: 'NVIDIA NIM',          url: 'https://integrate.api.nvidia.com/v1/models' },
  { id: 'cloudflare', label: 'Cloudflare Workers AI', url: 'https://api.cloudflare.com/client/v4/accounts/x/ai/v1/models' },
  { id: 'hf',         label: 'Hugging Face',        url: 'https://router.huggingface.co/v1/models' },
  { id: 'together',   label: 'Together AI',         url: 'https://api.together.xyz/v1/models' },
  { id: 'cohere',     label: 'Cohere',              url: 'https://api.cohere.ai/compatibility/v1/models' },
  { id: 'deepseek',   label: 'DeepSeek',            url: 'https://api.deepseek.com/models' },
  { id: 'moonshot',   label: 'Moonshot (Kimi)',     url: 'https://api.moonshot.ai/v1/models' },
  { id: 'zai',        label: 'Z.ai (GLM)',          url: 'https://api.z.ai/api/paas/v4/models' },
  { id: 'dashscope',  label: 'Alibaba (Qwen)',      url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models' },
  { id: 'sambanova',  label: 'SambaNova',           url: 'https://api.sambanova.ai/v1/models' },
  { id: 'chutes',     label: 'Chutes',              url: 'https://llm.chutes.ai/v1/models' },
  { id: 'pollinations', label: 'Pollinations',      url: 'https://text.pollinations.ai/models' },
  { id: 'github',     label: 'GitHub Models',       url: 'https://models.github.ai/catalog/models' }
];

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[92m', red: '\x1b[91m', yellow: '\x1b[93m'
};

const BLOQUEO_DE_RED = /network settings|access denied|blocked|not available in your (country|region)|geo/i;

async function probe(c) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(c.url, { signal: ctrl.signal });
    const body = await res.text().catch(() => '');

    if (res.status === 410) {
      return { estado: 'RETIRADO', color: C.red, detalle: 'el servicio ya no existe' };
    }
    if (res.status === 403 && BLOQUEO_DE_RED.test(body)) {
      return { estado: 'BLOQUEADO', color: C.red, detalle: 'rechaza tu red/IP' };
    }
    if (res.status === 200) {
      let n = '';
      try {
        const j = JSON.parse(body);
        const arr = j.data || j.models || j.result || j;
        if (Array.isArray(arr)) n = arr.length + ' modelos visibles sin llave';
      } catch (e) { /* no era json */ }
      return { estado: 'ALCANZABLE', color: C.green, detalle: n || 'responde 200' };
    }
    if (res.status === 401 || res.status === 403 || res.status === 400 || res.status === 404) {
      return { estado: 'ALCANZABLE', color: C.green, detalle: 'pide credenciales (HTTP ' + res.status + ')' };
    }
    return { estado: 'RARO', color: C.yellow, detalle: 'HTTP ' + res.status };
  } catch (err) {
    const motivo = err.name === 'AbortError' ? 'timeout' : (err.cause && err.cause.code) || err.message;
    return { estado: 'INALCANZABLE', color: C.red, detalle: String(motivo).slice(0, 40) };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log('');
  console.log(C.bold + '  ALCANZABILIDAD DESDE ESTA RED' + C.reset);
  console.log(C.dim + '  Sin API keys, sin generar tokens.' + C.reset);
  console.log('');

  const results = await Promise.all(CANDIDATOS.map(async (c) => [c, await probe(c)]));

  for (const [c, r] of results) {
    console.log(
      '  ' + r.color + r.estado.padEnd(13) + C.reset +
      c.label.padEnd(24) + C.dim + r.detalle + C.reset
    );
  }
  console.log('');
})();
