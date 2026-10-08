'use strict';

/**
 * Pone el icono y los metadatos de GCenter en el ejecutable empaquetado.
 *
 * Normalmente de esto se encarga electron-builder, pero su paquete winCodeSign
 * no se puede descomprimir en Windows sin Modo Desarrollador (trae symlinks de
 * macOS). Como el rcedit que necesitamos si queda extraido en su cache, lo
 * usamos directamente.
 *
 * Es un paso opcional: si no encuentra rcedit avisa y sigue, el .exe funciona
 * igual, solo que con el icono generico de Electron.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const pkg = require('../package.json');

const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'GCenter.exe');
const ICON = path.join(__dirname, '..', 'assets', 'icon.ico');

/** Busca rcedit-x64.exe en la cache de electron-builder. */
function findRcedit() {
  const cache = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'electron-builder',
    'Cache',
    'winCodeSign'
  );
  if (!fs.existsSync(cache)) return null;

  for (const entry of fs.readdirSync(cache)) {
    const candidate = path.join(cache, entry, 'rcedit-x64.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

if (!fs.existsSync(EXE)) {
  console.error('No encuentro ' + EXE + '. Ejecuta antes: electron-builder --win dir');
  process.exit(1);
}

const rcedit = findRcedit();
if (!rcedit) {
  console.warn(
    'aviso: no hay rcedit en la cache de electron-builder, el .exe se queda con\n' +
    '       el icono de Electron. Para arreglarlo, activa el Modo Desarrollador de\n' +
    '       Windows y vuelve a lanzar el build.'
  );
  process.exit(0);
}

const version = pkg.version + '.0';

execFileSync(rcedit, [
  EXE,
  '--set-icon', ICON,
  '--set-file-version', version,
  '--set-product-version', version,
  '--set-version-string', 'ProductName', 'GCenter',
  '--set-version-string', 'FileDescription', pkg.description,
  '--set-version-string', 'CompanyName', pkg.author,
  '--set-version-string', 'LegalCopyright', 'MIT',
  '--set-version-string', 'OriginalFilename', 'GCenter.exe'
], { stdio: 'inherit' });

console.log('icono y metadatos aplicados a GCenter.exe');
