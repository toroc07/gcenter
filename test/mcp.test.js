'use strict';

/**
 * Prueba de humo del servidor MCP: lo arranca, hace el handshake y lista las
 * herramientas. No gasta ni un token: no llama a ningun modelo.
 */

const { spawn } = require('child_process');
const path = require('path');

/**
 * Sin argumentos prueba el codigo fuente con el Node del sistema. Pasandole el
 * GCenter.exe empaquetado y la ruta a server.js dentro del asar, comprueba que
 * la version distribuida tambien arranca:
 *
 *   node test/mcp.test.js dist/win-unpacked/GCenter.exe \
 *     dist/win-unpacked/resources/app.asar/src/mcp/server.js
 */
const [cmd, script] = process.argv.slice(2);
const command = cmd || process.execPath;
const args = [script || path.join(__dirname, '..', 'src', 'mcp', 'server.js')];

console.log('probando: ' + path.basename(command) + ' ' + args[0] + '\n');

const server = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' })
});

let out = '';
server.stdout.on('data', (d) => {
  out += d.toString();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      handle(msg);
    } catch (e) {
      /* mensaje incompleto */
    }
  }
});

server.stderr.on('data', (d) => process.stderr.write('  [stderr] ' + d));

function send(obj) {
  server.stdin.write(JSON.stringify(obj) + '\n');
}

const seen = new Set();
function handle(msg) {
  if (seen.has(msg.id)) return;
  seen.add(msg.id);

  if (msg.id === 1) {
    console.log('✓ handshake OK ->', msg.result.serverInfo.name, msg.result.serverInfo.version);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  }

  if (msg.id === 2) {
    console.log('✓ herramientas expuestas:');
    for (const t of msg.result.tools) {
      const params = Object.keys(t.inputSchema.properties || {}).join(', ') || '(ninguno)';
      console.log('   - ' + t.name.padEnd(20) + ' params: ' + params);
    }
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'agents_available', arguments: {} }
    });
  }

  if (msg.id === 3) {
    const text = msg.result.content[0].text;
    console.log('\n✓ agents_available respondio:\n');
    console.log(text.split('\n').slice(0, 30).map((l) => '   ' + l).join('\n'));
    server.kill();
    process.exit(0);
  }
}

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gcenter-test', version: '1.0.0' }
  }
});

setTimeout(() => {
  console.error('✕ timeout: el servidor no respondio');
  server.kill();
  process.exit(1);
}, 20000);
