'use strict';

/**
 * Prueba de la carrera al reiniciar la sesion.
 *
 * El fallo que reprodujo el usuario: al reiniciar (cambiar de carpeta, de modo,
 * o Ctrl+Shift+R), el aviso de salida del proceso viejo llegaba despues de
 * arrancar el nuevo y borraba su referencia. Claude seguia vivo pero GCenter ya
 * no podia escribirle, mostraba "sesion cerrada" y el proceso quedaba huerfano.
 *
 * Arranca Claude de verdad (sin enviarle ningun prompt, asi que no consume
 * tokens), lo reinicia varias veces seguidas y comprueba:
 *
 *   1. que despues de cada reinicio la sesion sigue marcada como activa
 *   2. que no llega ningun aviso de "sesion cerrada" falso
 *   3. que no se acumulan procesos de Claude huerfanos
 *   4. que al parar no queda ninguno vivo
 *
 *   node test/reinicio.test.js
 */

const { execSync } = require('child_process');
const { ClaudeSession } = require(process.env.SESION || '../src/main/session');

const C = { ok: '\x1b[92m✓\x1b[0m', no: '\x1b[91m✕\x1b[0m', d: '\x1b[2m', r: '\x1b[0m' };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** Procesos de Claude lanzados con la configuracion MCP de GCenter. */
function clauDeGCenter() {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'claude.exe\'\\" | ' +
        'Where-Object { $_.CommandLine -like \'*GCenter*mcp.json*\' }).ProcessId"',
        { encoding: 'utf8' }
      );
      return out.split(/\s+/).filter(Boolean).map(Number);
    }

    // En Linux la ruta de la config es ~/.config/gcenter/mcp.json
    const mcp = require('../src/shared/config').MCP_CONFIG_PATH;
    return execSync('ps -eo pid=,args=', { encoding: 'utf8' })
      .split('\n')
      .filter((l) => /\bclaude\b/.test(l) && l.includes(mcp))
      .map((l) => Number(l.trim().split(/\s+/)[0]));
  } catch (e) {
    return [];
  }
}

async function main() {
  const antes = clauDeGCenter();
  console.log('\n  Procesos de Claude de GCenter antes de empezar: ' + antes.length);

  const eventos = [];
  const sesion = new ClaudeSession({ emit: (canal, datos) => eventos.push({ canal, datos, en: Date.now() }) });
  sesion.setBus(1, 'prueba');

  sesion.start();
  await espera(4000);

  const REINICIOS = 3;
  let falsasSalidas = 0;
  let siempreActiva = true;

  for (let i = 1; i <= REINICIOS; i++) {
    const marca = Date.now();
    sesion.stop();
    sesion.start();
    // Damos tiempo de sobra a que llegue el aviso de salida del proceso viejo,
    // que es justo lo que antes estropeaba la sesion nueva
    await espera(4000);

    const salidas = eventos.filter((e) => e.canal === 'session:exit' && e.en >= marca).length;
    falsasSalidas += salidas;
    if (!sesion.running) siempreActiva = false;

    console.log(C.d + '    reinicio ' + i + ': activa=' + sesion.running +
      ', avisos de cierre=' + salidas + ', procesos vivos=' + (clauDeGCenter().length - antes.length) + C.r);
  }

  const vivosTrasReinicios = clauDeGCenter().length - antes.length;

  console.log('');
  console.log('  ' + (siempreActiva ? C.ok : C.no) + ' 1. La sesion sigue activa tras cada reinicio');
  console.log('  ' + (falsasSalidas === 0 ? C.ok : C.no) + ' 2. Avisos de "sesion cerrada" falsos: ' + falsasSalidas);
  console.log('  ' + (vivosTrasReinicios === 1 ? C.ok : C.no) + ' 3. Procesos vivos tras ' + REINICIOS +
    ' reinicios: ' + vivosTrasReinicios + ' (deberia ser 1)');

  sesion.stop();
  await espera(3000);
  const vivosAlFinal = clauDeGCenter().length - antes.length;
  console.log('  ' + (vivosAlFinal <= 0 ? C.ok : C.no) + ' 4. Procesos vivos tras parar: ' +
    Math.max(0, vivosAlFinal) + ' (deberia ser 0)\n');

  process.exit(siempreActiva && falsasSalidas === 0 && vivosTrasReinicios === 1 && vivosAlFinal <= 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
