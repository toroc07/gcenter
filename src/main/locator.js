'use strict';

/**
 * Encuentra los ejecutables de los orquestadores: Claude Code y OpenCode.
 *
 * No damos por hecho que esten en el PATH. Al abrir GCenter desde el menu de
 * aplicaciones (en Linux y sobre todo en macOS) el PATH es el minimo del
 * sistema, sin ~/.local/bin, sin Homebrew y sin las instalaciones de Node
 * hechas con nvm. Probamos todas las rutas conocidas y, como ultimo recurso,
 * le preguntamos al sistema.
 *
 * GCenter solo localiza el programa: la cuenta con la que se usa es la que el
 * propio usuario haya iniciado en el.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const win = process.platform === 'win32';

/** Rutas habituales de cada programa, de mas a menos probable. */
function candidates(bin) {
  const home = os.homedir();
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const list = [];

  if (bin === 'claude') {
    if (win) {
      list.push(path.join(home, '.local', 'bin', 'claude.exe'));
      list.push(path.join(localAppData, 'Programs', 'claude', 'claude.exe'));
      list.push(path.join(appData, 'npm', 'claude.cmd'));
      list.push(path.join(home, '.claude', 'local', 'claude.exe'));
    } else {
      list.push(path.join(home, '.local', 'bin', 'claude'));
      list.push(path.join(home, '.claude', 'local', 'claude'));
      list.push(path.join(home, '.npm-global', 'bin', 'claude'));
      list.push('/opt/homebrew/bin/claude');
      list.push('/usr/local/bin/claude');
      list.push('/usr/bin/claude');
      list.push(...instalacionesNvm(home, 'claude'));
    }
  }

  if (bin === 'opencode') {
    if (win) {
      // El paquete de npm trae un .exe de verdad: mejor lanzarlo directamente
      // que pasar por el .cmd que npm crea al lado
      list.push(path.join(appData, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));
      list.push(path.join(appData, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'));
      list.push(path.join(home, '.opencode', 'bin', 'opencode.exe'));
      list.push(path.join(localAppData, 'Programs', 'opencode', 'opencode.exe'));
      list.push(path.join(home, '.local', 'bin', 'opencode.exe'));
      list.push(path.join(appData, 'npm', 'opencode.cmd'));
    } else {
      list.push(path.join(home, '.opencode', 'bin', 'opencode'));
      list.push(path.join(home, '.local', 'bin', 'opencode'));
      list.push(path.join(home, '.bun', 'bin', 'opencode'));
      list.push(path.join(home, '.npm-global', 'bin', 'opencode'));
      list.push('/opt/homebrew/bin/opencode');
      list.push('/usr/local/bin/opencode');
      list.push('/usr/bin/opencode');
      list.push(...instalacionesNvm(home, 'opencode'));
    }
  }

  return list.filter(Boolean);
}

/** El programa instalado con npm bajo cualquier version de Node gestionada por nvm. */
function instalacionesNvm(home, bin) {
  const base = path.join(home, '.nvm', 'versions', 'node');
  try {
    return fs.readdirSync(base)
      // Las versiones mas recientes primero, en orden numerico: alfabeticamente
      // "v9" quedaria por delante de "v22"
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      .map((v) => path.join(base, v, 'bin', bin));
  } catch (e) {
    return [];
  }
}

/**
 * Ultimo recurso: preguntarle al sistema donde esta. En Windows `where` puede
 * devolver tambien el envoltorio .ps1 de npm, que no se puede lanzar desde un
 * pseudo-terminal: preferimos un .exe y, si no hay, un .cmd.
 */
function fromPath(bin) {
  const cmd = win ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lineas = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && fs.existsSync(s));
    if (!win) return lineas[0] || null;
    return (
      lineas.find((l) => /\.exe$/i.test(l)) ||
      lineas.find((l) => /\.(cmd|bat)$/i.test(l)) ||
      null
    );
  } catch (e) {
    return null;
  }
}

/**
 * Ruta del ejecutable, o null si no esta instalado.
 * @param {'claude'|'opencode'} bin
 * @param {string} [preferred] ruta fijada a mano por el usuario
 */
function locate(bin, preferred) {
  if (preferred && fs.existsSync(preferred)) return preferred;

  for (const c of candidates(bin)) {
    if (fs.existsSync(c)) return c;
  }
  return fromPath(bin);
}

module.exports = { locate, candidates };
