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

exports.default = async function afterPack(context) {
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
