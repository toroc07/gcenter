'use strict';

/**
 * Comprueba que cada modo de permisos arranca de verdad.
 *
 * Que una opcion aparezca en la lista de valores validos no garantiza que la
 * sesion interactiva la acepte: algunas requieren banderas adicionales. Esto
 * lanza Claude con cada modo, mira los primeros segundos de salida y lo cierra.
 *
 * No envia ningun prompt, asi que no consume tokens.
 */

const pty = require('@lydell/node-pty');
const path = require('path');
const { locate } = require('../src/main/claude-locator');

const MODOS = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const bin = locate();

function probar(modo) {
  return new Promise((resolve) => {
    let salida = '';
    let vivo = true;

    const p = pty.spawn(bin, ['--permission-mode', modo, '--name', 'test'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: undefined })
    });

    p.onData((d) => { salida += d; });
    p.onExit(({ exitCode }) => {
      vivo = false;
      resolve({ modo, arranco: false, exitCode, salida });
    });

    setTimeout(() => {
      if (!vivo) return;
      try { p.kill(); } catch (e) { /* ya murio */ }
      resolve({ modo, arranco: true, salida });
    }, 6000);
  });
}

(async () => {
  console.log('\n  Probando cada modo de permisos (sin enviar prompts)\n');

  for (const modo of MODOS) {
    const r = await probar(modo);
    const limpio = r.salida.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\s+/g, ' ').trim();

    if (r.arranco) {
      // Buscamos si la propia interfaz menciona el modo o alguna advertencia
      const aviso = /bypass|dangerous|not permitted|no permitido|requires/i.exec(limpio);
      console.log('  \x1b[92mARRANCA\x1b[0m   ' + modo.padEnd(20) +
        (aviso ? '\x1b[93m(menciona: ' + aviso[0] + ')\x1b[0m' : ''));
    } else {
      console.log('  \x1b[91mFALLA\x1b[0m     ' + modo.padEnd(20) +
        'exit=' + r.exitCode + '  ' + limpio.slice(0, 120));
    }
  }
  console.log('');
  process.exit(0);
})();
