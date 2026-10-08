'use strict';

/**
 * Prueba del pseudo-terminal.
 *
 * El binario nativo de node-pty es lo unico de GCenter que depende de la
 * plataforma, y es facil empaquetar el equivocado: npm solo descarga el de la
 * maquina donde se instala, asi que un paquete de Linux construido desde
 * Windows llevaria el binario de Windows y no podria abrir el terminal.
 *
 * Abre un pseudo-terminal, ejecuta un eco y comprueba que vuelve la salida.
 *
 *   node test/pty.test.js
 *
 * Para probar el que va DENTRO de una app empaquetada, se ejecuta con el propio
 * binario de la app como Node y se le pasa la ruta del modulo empaquetado:
 *
 *   ELECTRON_RUN_AS_NODE=1 dist/linux-unpacked/gcenter test/pty.test.js \
 *     "$PWD/dist/linux-unpacked/resources/app.asar/node_modules/@lydell/node-pty"
 */

const modulo = process.argv[2] || '@lydell/node-pty';
const MARCA = 'GCENTER_PTY_OK';

let pty;
try {
  pty = require(modulo);
} catch (err) {
  console.error('✕ no se pudo cargar node-pty desde ' + modulo + ': ' + err.message);
  process.exit(1);
}

const [cmd, args] = process.platform === 'win32'
  ? ['cmd.exe', ['/c', 'echo ' + MARCA]]
  : ['/bin/sh', ['-c', 'echo ' + MARCA]];

let salida = '';
const proc = pty.spawn(cmd, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });

proc.onData((d) => {
  salida += d;
  if (salida.includes(MARCA)) {
    console.log('✓ pseudo-terminal operativo (' + process.platform + '-' + process.arch + ')');
    process.exit(0);
  }
});

setTimeout(() => {
  console.error('✕ el pseudo-terminal no devolvio la salida esperada');
  console.error('  recibido: ' + JSON.stringify(salida.slice(0, 200)));
  process.exit(1);
}, 10000);
