'use strict';

/**
 * Prueba de extremo a extremo contra TODOS los proveedores configurados a la
 * vez, usando la misma herramienta que usaria Claude (delegate_parallel).
 *
 *   node test/all-providers.test.js
 *
 * Gasta unos pocos tokens gratuitos por proveedor: pide una sola frase corta.
 * Sirve para confirmar que cada llave funciona de verdad y que el lote paralelo
 * se comporta.
 */

const { spawn } = require('child_process');
const path = require('path');

const providers = require('../src/mcp/providers');
const config = require('../src/shared/config');

// Si alguno de estos esta disponible lo preferimos, porque es mas ilustrativo
// que el primero que salga del catalogo
const PREFERIDOS = {
  nvidia: ['moonshotai/kimi-k3', 'moonshotai/kimi-k2.6', 'nvidia/nemotron-3-super-120b-a12b'],
  groq: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
  gemini: ['gemini-flash-latest'],
  mistral: ['mistral-small-latest'],
  openrouter: []
};

const PREGUNTA =
  'Responde en una sola frase de menos de 15 palabras, en espanol: ' +
  'que te hace distinto de otros modelos de lenguaje?';

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp', 'server.js')], {
  stdio: ['pipe', 'pipe', 'pipe']
});
server.stderr.on('data', () => {});

let buffer = '';
const waiting = new Map();
server.stdout.on('data', (d) => {
  buffer += d.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolve = waiting.get(msg.id);
      if (resolve) { waiting.delete(msg.id); resolve(msg); }
    } catch (e) { /* linea partida */ }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function main() {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gcenter-e2e', version: '1.0.0' }
  });

  // Elegimos un modelo vivo por proveedor
  const tasks = [];
  for (const p of providers.listProviders()) {
    const key = config.apiKeyFor(p.id, p.keyName);
    if (!key) {
      console.log('  \x1b[2m○ ' + p.label + ': sin llave, se salta\x1b[0m');
      continue;
    }

    const catalog = await providers.fetchModels(p.id, key);
    if (!catalog.ok || !catalog.models.length) {
      console.log('  \x1b[91m✕ ' + p.label + ': no pude listar modelos (' + catalog.error + ')\x1b[0m');
      continue;
    }

    const preferido = (PREFERIDOS[p.id] || []).find((m) => catalog.models.includes(m));
    tasks.push({
      role: p.label.split(' ')[0].toUpperCase(),
      provider: p.id,
      model: preferido || catalog.models[0],
      prompt: PREGUNTA,
      // Margen de sobra: los modelos de razonamiento gastan cientos de tokens
      // pensando antes de escribir la primera palabra de la respuesta
      max_tokens: 800,
      temperature: 0.4
    });
  }

  console.log('\n  Lanzando ' + tasks.length + ' agentes en paralelo...\n');
  for (const t of tasks) {
    console.log('    \x1b[96m' + t.role.padEnd(12) + '\x1b[0m\x1b[2m' + t.model + '\x1b[0m');
  }
  console.log('');

  const started = Date.now();
  const res = await rpc('tools/call', { name: 'delegate_parallel', arguments: { tasks } });
  const wall = ((Date.now() - started) / 1000).toFixed(1);

  const salida = res.result ? res.result.content[0].text : JSON.stringify(res.error);
  console.log(salida);
  console.log('\n  Tiempo total de pared: ' + wall + 's\n');

  server.kill();
  process.exit(salida.includes('FALLO') ? 1 : 0);
}

main().catch((e) => {
  console.error('fallo:', e.message);
  server.kill();
  process.exit(1);
});

setTimeout(() => { console.error('timeout'); server.kill(); process.exit(1); }, 240000);
