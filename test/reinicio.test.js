'use strict';

/**
 * Prueba la carrera al reiniciar la sesion, con cualquiera de los dos
 * orquestadores.
 *
 * El fallo que reprodujo el usuario: al reiniciar (cambiar de carpeta, de modo,
 * o Ctrl+Shift+R), el aviso de salida del proceso viejo llegaba despues de
 * arrancar el nuevo y borraba su referencia. El orquestador seguia vivo pero
 * GCenter ya no podia escribirle, mostraba "sesion cerrada" y el proceso
 * quedaba huerfano.
 *
 * Arranca el orquestador de verdad (sin enviarle ningun prompt, asi que no
 * consume tokens), lo reinicia varias veces seguidas y comprueba:
 *
 *   1. que despues de cada reinicio la sesion sigue marcada como activa
 *   2. que no llega ningun aviso de "sesion cerrada" falso
 *   3. que no se acumulan procesos huerfanos, ni del orquestador ni del
 *      servidor MCP de GCenter que este lanza
 *   4. que al parar no queda ninguno vivo
 *
 * Usa una carpeta de configuracion temporal: no toca la tuya.
 *
 *   node test/reinicio.test.js            (Claude Code)
 *   ORQUESTADOR=opencode node test/reinicio.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

process.env.GCENTER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gcenter-reinicio-'));
const ORQ = process.env.ORQUESTADOR || 'claude';

const { Session } = require(process.env.SESION || '../src/main/session');

const C = { ok: '\x1b[92m✓\x1b[0m', no: '\x1b[91m✕\x1b[0m', d: '\x1b[2m', r: '\x1b[0m' };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const SERVIDOR = path.join(__dirname, '..', 'src', 'mcp', 'server.js');

/** Procesos vivos de la prueba: el orquestador y el servidor MCP de GCenter. */
function contar() {
  const esOrq = (exe, cmd) =>
    ORQ === 'claude'
      ? /claude/i.test(exe) && cmd.includes('mcp.json') && cmd.includes(process.env.GCENTER_HOME)
      : /opencode/i.test(exe) && cmd.includes('--standalone');
  const esMcp = (cmd) => cmd.toLowerCase().includes(SERVIDOR.toLowerCase());

  let filas = [];
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
        'ForEach-Object { $_.Name + [char]9 + $_.CommandLine }"',
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
      );
      filas = out.split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length === 2);
    } else {
      filas = execSync('ps -eo comm=,args=', { encoding: 'utf8' })
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => [l.split(/\s+/)[0], l]);
    }
  } catch (e) {
    return { orq: 0, mcp: 0 };
  }

  return {
    orq: filas.filter(([exe, cmd]) => esOrq(exe, cmd || '')).length,
    mcp: filas.filter(([, cmd]) => esMcp(cmd || '')).length
  };
}

async function main() {
  const antes = contar();
  console.log('\n  Orquestador: ' + ORQ + C.d + '  (procesos previos: ' + antes.orq + ' / MCP ' + antes.mcp + ')' + C.r);

  const eventos = [];
  const sesion = new Session({
    emit: (canal, datos) => eventos.push({ canal, datos, en: Date.now() }),
    orchestrator: ORQ
  });
  sesion.setBus(1, 'prueba');

  if (!sesion.start()) {
    const err = eventos.find((e) => e.canal === 'session:error');
    console.log('  ' + C.no + ' no arranca: ' + (err ? err.datos.message : '?'));
    process.exit(1);
  }
  await espera(6000);

  const REINICIOS = 3;
  let falsasSalidas = 0;
  let siempreActiva = true;

  for (let i = 1; i <= REINICIOS; i++) {
    const marca = Date.now();
    sesion.stop();
    sesion.start();
    // Damos tiempo de sobra a que llegue el aviso de salida del proceso viejo,
    // que es justo lo que antes estropeaba la sesion nueva
    await espera(6000);

    const salidas = eventos.filter((e) => e.canal === 'session:exit' && e.en >= marca).length;
    falsasSalidas += salidas;
    if (!sesion.running) siempreActiva = false;

    const n = contar();
    console.log(C.d + '    reinicio ' + i + ': activa=' + sesion.running + ', avisos de cierre=' + salidas +
      ', orquestador=' + (n.orq - antes.orq) + ', servidor MCP=' + (n.mcp - antes.mcp) + C.r);
  }

  const tras = contar();
  const orqVivos = tras.orq - antes.orq;
  const mcpVivos = tras.mcp - antes.mcp;

  console.log('');
  console.log('  ' + (siempreActiva ? C.ok : C.no) + ' 1. La sesion sigue activa tras cada reinicio');
  console.log('  ' + (falsasSalidas === 0 ? C.ok : C.no) + ' 2. Avisos de "sesion cerrada" falsos: ' + falsasSalidas);
  console.log('  ' + (orqVivos <= 1 && mcpVivos <= 1 ? C.ok : C.no) + ' 3. Tras ' + REINICIOS +
    ' reinicios: ' + orqVivos + ' orquestador y ' + mcpVivos + ' servidor MCP (deberia ser como mucho 1 de cada)');

  sesion.stop();
  await espera(4000);
  const fin = contar();
  const restos = Math.max(0, fin.orq - antes.orq) + Math.max(0, fin.mcp - antes.mcp);
  console.log('  ' + (restos === 0 ? C.ok : C.no) + ' 4. Procesos vivos tras parar: ' + restos + ' (deberia ser 0)\n');

  fs.rmSync(process.env.GCENTER_HOME, { recursive: true, force: true });
  process.exit(siempreActiva && falsasSalidas === 0 && orqVivos <= 1 && mcpVivos <= 1 && restos === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
