'use strict';

/**
 * Encuentra el ejecutable de Claude Code.
 *
 * No damos por hecho que este en el PATH: el instalador nativo lo deja en
 * ~/.local/bin, y la instalacion por npm en %APPDATA%\npm. Probamos todas las
 * rutas conocidas y dejamos que el usuario fije una a mano si hiciera falta.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function candidates() {
  const home = os.homedir();
  const win = process.platform === 'win32';
  const list = [];

  if (win) {
    list.push(path.join(home, '.local', 'bin', 'claude.exe'));
    list.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'));
    list.push(path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'));
    list.push(path.join(home, '.claude', 'local', 'claude.exe'));
  } else {
    list.push(path.join(home, '.local', 'bin', 'claude'));
    list.push('/usr/local/bin/claude');
    list.push('/opt/homebrew/bin/claude');
  }

  return list.filter(Boolean);
}

/** Ultimo recurso: preguntarle al sistema donde esta. */
function fromPath() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first && fs.existsSync(first) ? first : null;
  } catch (e) {
    return null;
  }
}

function locate(preferred) {
  if (preferred && fs.existsSync(preferred)) return preferred;

  for (const c of candidates()) {
    if (fs.existsSync(c)) return c;
  }
  return fromPath();
}

module.exports = { locate, candidates };
