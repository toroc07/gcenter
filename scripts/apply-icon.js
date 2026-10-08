'use strict';

/**
 * Pone el icono y los metadatos de GCenter en el ejecutable de Windows.
 *
 * Normalmente de esto se encarga electron-builder, pero su paquete winCodeSign
 * trae symlinks de macOS que Windows no deja crear sin Modo Desarrollador, y su
 * descarga aborta el build. Por eso el build lleva signAndEditExecutable
 * desactivado y el icono se aplica aqui con rcedit, el paquete npm que mantiene
 * la propia organizacion de Electron. Asi `npm run dist` funciona igual en
 * cualquier Windows, incluida la maquina de GitHub Actions que compila las
 * Releases.
 */

const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');

const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'GCenter.exe');
const ICON = path.join(__dirname, '..', 'assets', 'icon.ico');

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error('No encuentro ' + EXE + '. Ejecuta antes: npm run pack');
    process.exit(1);
  }

  // rcedit es un modulo ES: desde CommonJS solo se puede cargar con import()
  const { rcedit } = await import('rcedit');
  const version = pkg.version + '.0';

  await rcedit(EXE, {
    icon: ICON,
    'file-version': version,
    'product-version': version,
    'version-string': {
      ProductName: 'GCenter',
      FileDescription: pkg.description,
      CompanyName: pkg.author,
      LegalCopyright: 'MIT',
      OriginalFilename: 'GCenter.exe'
    }
  });

  console.log('icono y metadatos aplicados a GCenter.exe');
}

main().catch((err) => {
  console.error('No se pudo aplicar el icono: ' + err.message);
  process.exit(1);
});
