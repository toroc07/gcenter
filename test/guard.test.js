'use strict';

/**
 * Prueba la barrera de gratuidad.
 *
 * Intenta delegar a modelos de pago conocidos y verifica que se rechazan ANTES
 * de llamar al proveedor. Como el bloqueo ocurre antes de la peticion, este
 * test no gasta ni un token ni un centimo.
 *
 *   node test/guard.test.js
 */

const { spawn } = require('child_process');
const path = require('path');

const CASOS_DE_PAGO = [
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', porque: 'modelo premium de OpenRouter' },
  { provider: 'openrouter', model: 'openai/gpt-5', porque: 'modelo premium de OpenRouter' },
  { provider: 'mistral', model: 'mistral-medium-latest', porque: 'Mistral Medium es de pago' },
  { provider: 'mistral', model: 'codestral-latest', porque: 'Codestral es de pago' },
  { provider: 'gemini', model: 'deep-research-max-preview-04-2026', porque: 'Deep Research es de pago' },
  { provider: 'gemini', model: 'veo-3.1-generate-preview', porque: 'generacion de video, de pago' },
  { provider: 'gemini', model: 'gemini-3.1-pro-preview', porque: 'Gemini Pro de ultima generacion, fuera del tier gratis' }
];

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp', 'server.js')], {
  stdio: ['pipe', 'pipe', 'pipe']
});

server.stderr.on('data', () => {}); // el log del bus no nos interesa aqui

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
      if (resolve) {
        waiting.delete(msg.id);
        resolve(msg);
      }
    } catch (e) {
      /* linea partida */
    }
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
    clientInfo: { name: 'gcenter-guard-test', version: '1.0.0' }
  });

  console.log('\n  BARRERA DE GRATUIDAD — intentando delegar a modelos de pago\n');

  let bloqueados = 0;

  for (const caso of CASOS_DE_PAGO) {
    const res = await rpc('tools/call', {
      name: 'delegate',
      arguments: {
        role: 'TEST',
        provider: caso.provider,
        model: caso.model,
        prompt: 'di hola',
        max_tokens: 64
      }
    });

    const texto = res.result ? res.result.content[0].text : JSON.stringify(res.error);
    const fueBloqueado = texto.includes('POLITICA DE GRATUIDAD');

    if (fueBloqueado) bloqueados += 1;
    const marca = fueBloqueado ? '\x1b[92m✓ BLOQUEADO\x1b[0m' : '\x1b[91m✕ SE COLO\x1b[0m';
    console.log('  ' + marca + '  ' + caso.provider + ' / ' + caso.model);
    console.log('             \x1b[2m' + caso.porque + '\x1b[0m');
    if (!fueBloqueado) {
      console.log('             \x1b[91m' + texto.split('\n').slice(0, 3).join(' ') + '\x1b[0m');
    }
  }

  console.log('\n  Resultado: ' + bloqueados + '/' + CASOS_DE_PAGO.length + ' modelos de pago rechazados\n');

  // Y ahora uno gratuito, para confirmar que la barrera no bloquea de mas.
  // Este SI llama al proveedor, pero pidiendo 16 tokens a un modelo gratis.
  const disponibles = await rpc('tools/call', { name: 'agents_available', arguments: {} });
  const texto = disponibles.result.content[0].text;
  const primerModelo = (texto.match(/^ {5}- (.+)$/m) || [])[1];

  if (primerModelo) {
    const proveedor = (texto.slice(0, texto.indexOf(primerModelo)).match(/provider="(\w+)"/g) || []).pop();
    const pid = proveedor ? proveedor.match(/"(\w+)"/)[1] : null;
    if (pid) {
      console.log('  Control: delegando de verdad a ' + pid + ' / ' + primerModelo + '...');
      const ok = await rpc('tools/call', {
        name: 'delegate',
        arguments: {
          role: 'CONTROL',
          provider: pid,
          model: primerModelo,
          prompt: 'Responde unicamente con la palabra: FUNCIONA',
          max_tokens: 64
        }
      });
      const t = ok.result.content[0].text;
      const paso = !t.includes('FALLO');
      console.log('  ' + (paso ? '\x1b[92m✓ el modelo gratuito SI pasa\x1b[0m' : '\x1b[91m✕ tambien bloqueo al gratuito\x1b[0m'));
      console.log('  \x1b[2m' + t.split('\n').slice(0, 5).join('\n  ') + '\x1b[0m\n');
    }
  }

  server.kill();
  process.exit(bloqueados === CASOS_DE_PAGO.length ? 0 : 1);
}

main().catch((e) => {
  console.error('fallo el test:', e.message);
  server.kill();
  process.exit(1);
});

setTimeout(() => {
  console.error('timeout');
  server.kill();
  process.exit(1);
}, 120000);
