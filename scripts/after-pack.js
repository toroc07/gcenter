'use strict';

/**
 * Poda lo que Electron trae y GCenter no usa.
 *
 * electron-builder no tiene opciones para excluir estos ficheros, asi que se
 * borran aqui, justo despues de empaquetar y antes de comprimir. Cada MB que
 * quitamos es menos que descomprimir al abrir el portable.
 *
 * Se declara en package.json como build.afterPack.
 */

const fs = require('fs');
const path = require('path');

/**
 * Compiladores de shaders de DirectX. Solo hacen falta para WebGPU, que esta
 * app no usa: es una terminal con un panel lateral.
 */
const SOBRAN = ['dxcompiler.dll', 'dxil.dll'];

function tam(p) {
  try {
    return fs.statSync(p).size;
  } catch (e) {
    return 0;
  }
}

/**
 * Firma ad hoc de la app de macOS.
 *
 * En Apple Silicon, macOS se niega a abrir una app cuya firma no corresponde a
 * su contenido. Electron viene firmado, pero al empaquetar se le anaden
 * archivos y esa firma deja de cuadrar ("code has no resources but signature
 * indicates they must be present"). Sin certificado de Apple no hay firma
 * oficial posible, pero una firma ad hoc ("-") basta para que la app se abra
 * tras permitirla en Privacidad y seguridad.
 *
 * Se hace aqui, y no con la opcion `identity` de electron-builder, porque esa
 * via no llego a firmar en la maquina de GitHub. En este punto la app ya esta
 * completa y el DMG todavia no se ha generado.
 */
function firmarAdHoc(context) {
  const { execFileSync } = require('child_process');
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log('  · firmada ad hoc: ' + path.basename(app));
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    firmarAdHoc(context);
    return;
  }

  const dir = context.appOutDir;
  let liberado = 0;

  for (const nombre of SOBRAN) {
    const f = path.join(dir, nombre);
    const bytes = tam(f);
    if (!bytes) continue;
    fs.unlinkSync(f);
    liberado += bytes;
    console.log('  · podado ' + nombre + ' (' + Math.round(bytes / 1024 / 1024) + ' MB)');
  }

  if (liberado) {
    console.log('  · total liberado: ' + Math.round(liberado / 1024 / 1024) + ' MB');
  }
};
