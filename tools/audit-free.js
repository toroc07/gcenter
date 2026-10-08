'use strict';

/**
 * Auditoria de gratuidad.
 *
 * Comprueba, proveedor por proveedor, que la llave funciona y que modelos hay
 * disponibles, separando los gratuitos de los de pago. El objetivo es que nadie
 * termine gastando dinero sin enterarse.
 *
 *   node tools/audit-free.js
 *
 * Solo hace peticiones de listado de modelos: no genera ni un token.
 */

const providers = require('../src/mcp/providers');
const config = require('../src/shared/config');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[91m', green: '\x1b[92m', yellow: '\x1b[93m',
  cyan: '\x1b[96m', magenta: '\x1b[95m'
};

function line(s) {
  console.log(s);
}

/** OpenRouter publica el precio de cada modelo, asi que podemos ser exactos. */
async function auditOpenRouter(key) {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: 'Bearer ' + key }
  });
  if (!res.ok) return { error: 'HTTP ' + res.status };

  const json = await res.json();
  const all = json.data || [];
  const free = all.filter(
    (m) => Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0
  );

  // El endpoint /key dice si la cuenta tiene creditos comprados
  let account = null;
  try {
    const kr = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: 'Bearer ' + key }
    });
    if (kr.ok) account = (await kr.json()).data;
  } catch (e) {
    /* opcional */
  }

  return { total: all.length, free: free.length, freeList: free.map((m) => m.id), account };
}

async function main() {
  const cfg = config.load();
  line('');
  line(C.bold + '  AUDITORIA DE GRATUIDAD — GCenter' + C.reset);
  line(C.dim + '  Solo se listan modelos; no se genera ningun token.' + C.reset);
  line('');

  for (const p of providers.listProviders()) {
    const key = config.apiKeyFor(p.id, p.keyName);

    if (!key) {
      line(C.dim + '  ○ ' + p.label.padEnd(16) + ' sin llave, no se usara' + C.reset);
      continue;
    }

    process.stdout.write('  · ' + p.label.padEnd(16) + ' comprobando...');

    if (p.id === 'openrouter') {
      const r = await auditOpenRouter(key);
      process.stdout.write('\r');
      if (r.error) {
        line(C.red + '  ✕ ' + p.label.padEnd(16) + ' ' + r.error + '            ' + C.reset);
        continue;
      }
      line(C.green + '  ✓ ' + p.label.padEnd(16) + C.reset +
        ' ' + r.free + ' modelos gratis de ' + r.total + ' totales');
      if (r.account) {
        const limit = r.account.limit;
        const usage = r.account.usage;
        line(C.dim + '      creditos: ' +
          (limit === null ? 'sin limite (cuenta con saldo -> OJO, los modelos de pago SI cobran)'
                          : 'limite ' + limit + ', usado ' + usage) + C.reset);
        line(C.dim + '      tier: ' + (r.account.is_free_tier ? 'gratuito' : 'de pago') + C.reset);
      }
      line(C.dim + '      ejemplos gratis: ' + r.freeList.slice(0, 4).join(', ') + C.reset);
      continue;
    }

    const r = await providers.fetchModels(p.id, key, { timeoutMs: 20000 });
    process.stdout.write('\r');

    if (!r.ok) {
      line(C.red + '  ✕ ' + p.label.padEnd(16) + ' ' + r.error + '            ' + C.reset);
      line(C.dim + '      (la llave no funciona o el servicio no responde)' + C.reset);
      continue;
    }

    line(C.green + '  ✓ ' + p.label.padEnd(16) + C.reset + ' ' + r.models.length + ' modelos accesibles');
    line(C.dim + '      ejemplos: ' + r.models.slice(0, 4).join(', ') + C.reset);
  }

  line('');
}

main().catch((e) => {
  console.error('fallo la auditoria:', e.message);
  process.exit(1);
});
