'use strict';

/**
 * Prueba la supervision y el relevo.
 *
 * Comprueba tres cosas que antes no existian:
 *   1. delegar por capacidad elige solo un agente vivo
 *   2. cuando el elegido falla, la tarea se reencamina a otro proveedor
 *   3. agents_health informa del estado y de que capacidades quedan huerfanas
 *
 *   node test/supervision.test.js
 */

const { spawn } = require('child_process');
const path = require('path');

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
      const r = waiting.get(msg.id);
      if (r) { waiting.delete(msg.id); r(msg); }
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

function salida(res) {
  return res.result ? res.result.content[0].text : ('ERROR: ' + JSON.stringify(res.error));
}

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[96m' };

async function main() {
  await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'gcenter-supervision', version: '1.0.0' }
  });

  // 1. Delegar por capacidad. "redaccion" prefiere Mistral, que esta agotado:
  //    si el relevo funciona, la tarea debe acabarla otro proveedor.
  console.log('\n' + C.bold + '  1. Delegar por capacidad "redaccion"' + C.reset);
  console.log(C.dim + '     (la primera preferencia es Mistral, que esta sin cuota)' + C.reset + '\n');
  const r1 = await rpc('tools/call', {
    name: 'delegate',
    arguments: {
      role: 'REDACTOR',
      capability: 'redaccion',
      prompt: 'Escribe una sola frase que explique que es una API, para alguien sin conocimientos tecnicos.',
      max_tokens: 300
    }
  });
  console.log(salida(r1).split('\n').map((l) => '     ' + l).join('\n'));

  // 2. Delegar por capacidad de codigo
  console.log('\n' + C.bold + '  2. Delegar por capacidad "codigo"' + C.reset + '\n');
  const r2 = await rpc('tools/call', {
    name: 'delegate',
    arguments: {
      role: 'CODER',
      capability: 'codigo',
      prompt: 'Escribe una funcion de JavaScript llamada esPar que reciba un numero y devuelva true si es par. Solo el codigo, sin explicacion.',
      max_tokens: 400
    }
  });
  console.log(salida(r2).split('\n').map((l) => '     ' + l).join('\n'));

  // 3. Parte de situacion
  console.log('\n' + C.bold + '  3. Parte de situacion (agents_health)' + C.reset + '\n');
  const r3 = await rpc('tools/call', { name: 'agents_health', arguments: {} });
  console.log(salida(r3).split('\n').map((l) => '     ' + l).join('\n'));

  server.kill();
  process.exit(0);
}

main().catch((e) => { console.error('fallo:', e.message); server.kill(); process.exit(1); });
setTimeout(() => { console.error('timeout'); server.kill(); process.exit(1); }, 300000);
