'use strict';

/**
 * Explorador de catalogos.
 *
 * Varios proveedores publican su lista de modelos sin pedir credenciales.
 * Esto los descarga y los agrupa por familia, para decidir con datos reales
 * —y no con articulos de blog— que merece la pena anadir a GCenter.
 *
 *   node tools/explore-catalogs.js          # resumen por familias
 *   node tools/explore-catalogs.js kimi     # busca una familia concreta
 *
 * No usa API keys y no genera tokens.
 */

const ABIERTOS = [
  { label: 'NVIDIA NIM',   url: 'https://integrate.api.nvidia.com/v1/models', pick: (j) => j.data },
  { label: 'Hugging Face', url: 'https://router.huggingface.co/v1/models',    pick: (j) => j.data },
  { label: 'Chutes',       url: 'https://llm.chutes.ai/v1/models',            pick: (j) => j.data },
  { label: 'SambaNova',    url: 'https://api.sambanova.ai/v1/models',         pick: (j) => j.data },
  { label: 'OpenRouter',   url: 'https://openrouter.ai/api/v1/models',        pick: (j) => j.data, soloGratis: true }
];

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[96m', green: '\x1b[92m' };

const filtro = (process.argv[2] || '').toLowerCase();

async function traer(src) {
  try {
    const res = await fetch(src.url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { src, error: 'HTTP ' + res.status, models: [] };

    const json = await res.json();
    let items = src.pick(json) || [];
    if (src.soloGratis) {
      items = items.filter(
        (m) => m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0
      );
    }
    return { src, models: items.map((m) => String(m.id)).sort() };
  } catch (err) {
    return { src, error: err.message, models: [] };
  }
}

/** Agrupa por el fabricante, que suele ser lo que va antes de la barra. */
function porFamilia(ids) {
  const grupos = new Map();
  for (const id of ids) {
    const fam = id.includes('/') ? id.split('/')[0] : id.split(/[-.]/)[0];
    if (!grupos.has(fam)) grupos.set(fam, []);
    grupos.get(fam).push(id);
  }
  return [...grupos.entries()].sort((a, b) => b[1].length - a[1].length);
}

(async () => {
  const results = await Promise.all(ABIERTOS.map(traer));

  console.log('');
  for (const { src, error, models } of results) {
    if (error) {
      console.log(C.bold + '  ' + src.label + C.reset + C.dim + '  (' + error + ')' + C.reset);
      console.log('');
      continue;
    }

    if (filtro) {
      const hits = models.filter((m) => m.toLowerCase().includes(filtro));
      console.log(C.bold + '  ' + src.label + C.reset + C.dim + '  ' + hits.length + ' coincidencias de "' + filtro + '" sobre ' + models.length + C.reset);
      for (const h of hits) console.log('    ' + C.green + h + C.reset);
      console.log('');
      continue;
    }

    console.log(C.bold + '  ' + src.label + C.reset + C.dim + '  ' + models.length + ' modelos' +
      (src.soloGratis ? ' gratuitos' : ' visibles sin llave') + C.reset);
    for (const [fam, list] of porFamilia(models).slice(0, 10)) {
      console.log('    ' + C.cyan + fam.padEnd(22) + C.reset + C.dim + list.length + '  ' +
        list.slice(0, 2).map((s) => s.split('/').pop()).join(', ') + C.reset);
    }
    console.log('');
  }
})();
