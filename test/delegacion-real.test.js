'use strict';

/**
 * Reproduce el caso que fallo en uso real: repartir una calculadora en varios
 * archivos de codigo. Comprueba que el arreglo funciona de verdad:
 *
 *   1. tres tareas de "codigo" van a TRES modelos distintos, no al mismo
 *   2. los archivos acaban en disco sin pasar por Claude
 *   3. lo que vuelve a Claude es un resumen, mucho mas pequeno que el codigo
 *   4. una ruta fuera del proyecto se rechaza
 *   5. las valoraciones cambian el orden del reparto
 *
 * Usa modelos gratuitos reales en una carpeta temporal. No gasta tokens de
 * Claude: es el servidor MCP hablando directamente con los agentes.
 *
 *   node test/delegacion-real.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const proyecto = fs.mkdtempSync(path.join(os.tmpdir(), 'gcenter-calc-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gcenter-home-'));

// Copiamos la config real (llaves incluidas) a un HOME aislado, para que las
// valoraciones de esta prueba no contaminen las tuyas
const cfgReal = path.join(process.env.APPDATA, 'GCenter', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgReal, 'utf8').replace(/^﻿/, ''));
cfg.permissionMode = 'acceptEdits';
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));

fs.writeFileSync(path.join(proyecto, 'CONTRATO.md'),
  '# Contrato\n\n' +
  '- `calc.js` define `window.Calc = { evaluate(expr, opts) }`. `opts.angle` es "DEG" o "RAD".\n' +
  '  Soporta + - * / ^ ( ), sin cos tan, sqrt, log (base 10), ln, pi, e. Lanza Error si la expresion es invalida.\n' +
  '  Sin eval ni Function.\n' +
  '- `index.html` tiene un `<input id="display" readonly>`, botones con `data-key` y un boton `id="eq"`.\n' +
  '  Carga `calc.js` y despues `app.js`.\n' +
  '- `app.js` engancha los botones: `data-key` se anade al display, `eq` llama a `Calc.evaluate`.\n');

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp', 'server.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: Object.assign({}, process.env, { GCENTER_HOME: home, GCENTER_CWD: proyecto })
});
server.stderr.on('data', () => {});

let buf = '';
const espera = new Map();
server.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const l = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!l) continue;
    try {
      const m = JSON.parse(l);
      const r = espera.get(m.id);
      if (r) { espera.delete(m.id); r(m); }
    } catch (e) { /* linea partida */ }
  }
});

let n = 1;
function rpc(method, params) {
  const id = n++;
  return new Promise((r) => {
    espera.set(id, r);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const texto = (res) => (res.result ? res.result.content[0].text : JSON.stringify(res.error));
const C = { ok: '\x1b[92m✓\x1b[0m', no: '\x1b[91m✕\x1b[0m', d: '\x1b[2m', r: '\x1b[0m', b: '\x1b[1m' };

async function main() {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  console.log('\n' + C.b + '  Proyecto de prueba: ' + proyecto + C.r + '\n');

  const sistema = 'Eres un ingeniero de JavaScript meticuloso. Sigues el contrato al pie de la letra.';
  const t0 = Date.now();
  const res = await rpc('tools/call', {
    name: 'delegate_parallel',
    arguments: {
      tasks: [
        { role: 'MOTOR', capability: 'codigo', system: sistema, max_tokens: 8000,
          prompt: 'Escribe calc.js segun el contrato.', context_files: ['CONTRATO.md'], output_file: 'calc.js' },
        { role: 'INTERFAZ', capability: 'codigo', system: sistema, max_tokens: 8000,
          prompt: 'Escribe app.js segun el contrato.', context_files: ['CONTRATO.md'], output_file: 'app.js' },
        { role: 'HTML', capability: 'codigo', system: sistema, max_tokens: 8000,
          prompt: 'Escribe index.html segun el contrato, con una rejilla de botones de calculadora cientifica.',
          context_files: ['CONTRATO.md'], output_file: 'index.html' }
      ]
    }
  });
  const salida = texto(res);
  const segundos = ((Date.now() - t0) / 1000).toFixed(1);

  // 1. Modelos distintos
  const usados = [...salida.matchAll(/^### \S+ +\[([^\]]+)\]/gm)].map((m) => m[1]);
  const distintos = new Set(usados).size;
  console.log('  ' + (distintos === usados.length ? C.ok : C.no) + ' 1. Reparto: ' + distintos +
    ' modelos distintos para ' + usados.length + ' tareas (' + segundos + 's)');
  usados.forEach((u) => console.log(C.d + '       ' + u + C.r));

  // 2. Archivos en disco
  const archivos = ['calc.js', 'app.js', 'index.html'].map((f) => {
    const p = path.join(proyecto, f);
    return { f, existe: fs.existsSync(p), bytes: fs.existsSync(p) ? fs.statSync(p).size : 0 };
  });
  const escritos = archivos.filter((a) => a.existe);
  console.log('  ' + (escritos.length === 3 ? C.ok : C.no) + ' 2. Archivos escritos en disco: ' +
    escritos.length + '/3');
  archivos.forEach((a) => console.log(C.d + '       ' + a.f.padEnd(11) +
    (a.existe ? a.bytes + ' bytes' : 'NO ESCRITO') + C.r));

  // 3. Ahorro: lo que vuelve a Claude frente a lo que se escribio
  const bytesDisco = escritos.reduce((s, a) => s + a.bytes, 0);
  const ahorro = bytesDisco ? Math.round((1 - salida.length / bytesDisco) * 100) : 0;
  console.log('  ' + (salida.length < bytesDisco ? C.ok : C.no) + ' 3. A Claude le llegan ' +
    salida.length + ' caracteres por ' + bytesDisco + ' bytes de codigo (' + ahorro + '% menos que leerlo)');

  const sint = [...salida.matchAll(/Sintaxis: (.+)/g)].map((m) => m[1]);
  sint.forEach((s) => console.log(C.d + '       sintaxis: ' + s + C.r));
  const fallos = [...salida.matchAll(/^(FALLO|RELEVO AL JEFE): (.+)$/gm)].map((m) => m[2].slice(0, 110));
  fallos.forEach((f) => console.log(C.d + '       fallo: ' + f + C.r));

  // 4. Fuga del directorio
  const fuga = await rpc('tools/call', {
    name: 'delegate',
    arguments: { role: 'FUGA', capability: 'rapido', prompt: 'di hola', output_file: '../fuera.js', max_tokens: 64 }
  });
  const fugaTxt = texto(fuga);
  const bloqueada = !fs.existsSync(path.join(proyecto, '..', 'fuera.js')) && /fuera del directorio/.test(fugaTxt);
  console.log('  ' + (bloqueada ? C.ok : C.no) + ' 4. Escritura fuera del proyecto ' +
    (bloqueada ? 'rechazada' : 'NO rechazada'));

  // 5. Las valoraciones cambian el reparto
  const antes = await rpc('tools/call', { name: 'agents_health', arguments: {} });
  const primero = (texto(antes).match(/codigo\s+cubierta por (.+)/) || [])[1];
  const [prov, mod] = String(primero || '').split(' / ');
  const pid = { 'NVIDIA NIM': 'nvidia', 'Groq': 'groq', 'OpenRouter': 'openrouter', 'OpenCode Zen': 'opencode',
    'Google Gemini': 'gemini', 'Mistral': 'mistral' }[prov];
  for (let i = 0; i < 3; i++) {
    await rpc('tools/call', { name: 'agents_feedback',
      arguments: { provider: pid, model: mod, rating: 'malo', reason: 'prueba' } });
  }
  const despues = await rpc('tools/call', { name: 'agents_health', arguments: {} });
  const nuevo = (texto(despues).match(/codigo\s+cubierta por (.+)/) || [])[1];
  console.log('  ' + (nuevo && nuevo !== primero ? C.ok : C.no) + ' 5. Tras tres "malo", el reparto de codigo pasa de');
  console.log(C.d + '       ' + primero + '\n       a ' + nuevo + C.r);

  console.log('\n' + C.d + '  Respuesta completa que veria Claude:\n' + C.r);
  console.log(salida.split('\n').map((l) => '    ' + l).join('\n'));

  server.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); server.kill(); process.exit(1); });
setTimeout(() => { console.error('timeout'); server.kill(); process.exit(1); }, 420000);
