'use strict';

/**
 * Acceso de los agentes al proyecto.
 *
 * Esta pieza es la que hace que delegar AHORRE tokens de verdad. Sin ella, el
 * circuito era:
 *
 *   Claude teclea el contexto en el prompt   -> tokens de salida de Claude
 *   el agente genera el archivo               -> gratis
 *   Claude lee la respuesta                   -> tokens de entrada de Claude
 *   Claude vuelve a teclear el archivo entero -> tokens de salida de Claude
 *
 * O sea: delegar un archivo costaba MAS que escribirlo directamente, porque
 * Claude pagaba el contenido dos veces. Con este modulo:
 *
 *   Claude pasa rutas, no contenido           -> unos pocos tokens
 *   el servidor lee los archivos de contexto  -> gratis
 *   el agente genera                          -> gratis
 *   el servidor escribe el resultado a disco  -> gratis
 *   Claude recibe un resumen y lo revisa      -> pocos tokens, y de entrada
 *
 * Todo queda encerrado en el directorio de trabajo de la sesion.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const config = require('../shared/config');

const MAX_CONTEXTO = 400 * 1024; // tope de lo que se adjunta a un prompt

/** Directorio raiz del proyecto: el mismo en el que trabaja la sesion de Claude. */
function raiz() {
  return path.resolve(process.env.GCENTER_CWD || config.load().cwd || process.cwd());
}

/**
 * Resuelve una ruta del proyecto y se niega a salir de el. Un agente no tiene
 * por que tocar nada fuera de la carpeta en la que se esta trabajando.
 */
function resolver(rel) {
  const base = raiz();
  const abs = path.resolve(base, String(rel || ''));
  const dentro = abs === base || abs.startsWith(base + path.sep);
  if (!dentro) {
    throw new Error('La ruta "' + rel + '" queda fuera del directorio de trabajo (' + base + ').');
  }
  return abs;
}

function lenguajeDe(ruta) {
  const ext = path.extname(ruta).slice(1).toLowerCase();
  const mapa = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript',
    py: 'python', html: 'html', css: 'css', json: 'json', md: 'markdown', sh: 'bash' };
  return mapa[ext] || ext || '';
}

/**
 * Lee los archivos de contexto y los formatea para incrustarlos en el prompt
 * del agente. Devuelve tambien que se adjunto y que falto, para avisar.
 */
function leerContexto(rutas) {
  const lista = Array.isArray(rutas) ? rutas : [];
  const bloques = [];
  const faltan = [];
  let total = 0;

  for (const rel of lista) {
    let abs;
    try {
      abs = resolver(rel);
    } catch (err) {
      faltan.push(rel + ' (' + err.message + ')');
      continue;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      faltan.push(rel + ' (no existe)');
      continue;
    }

    const contenido = fs.readFileSync(abs, 'utf8');
    if (total + contenido.length > MAX_CONTEXTO) {
      faltan.push(rel + ' (no cabe: se supero el tope de contexto)');
      continue;
    }
    total += contenido.length;
    bloques.push('### Archivo: ' + rel + '\n```' + lenguajeDe(rel) + '\n' + contenido + '\n```');
  }

  return {
    texto: bloques.length ? '\n\n## Contexto del proyecto\n\n' + bloques.join('\n\n') : '',
    adjuntos: lista.length - faltan.length,
    faltan,
    caracteres: total
  };
}

/**
 * Saca el contenido del archivo de la respuesta del agente. Los modelos suelen
 * envolverlo en un bloque ``` y a veces anaden explicaciones alrededor: nos
 * quedamos con el bloque mas largo, que es casi siempre el archivo.
 */
function extraerArchivo(texto) {
  const bloques = [];
  const re = /```[\w.+-]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(texto))) bloques.push(m[1]);

  if (bloques.length) {
    return bloques.sort((a, b) => b.length - a.length)[0].replace(/\s+$/, '') + '\n';
  }
  return texto.trim() + '\n';
}

/**
 * Comprobacion barata de sintaxis. No sustituye a la revision de Claude, pero
 * atrapa gratis el fallo mas tonto y mas frecuente: un archivo que ni compila.
 */
function comprobarSintaxis(ruta, contenido) {
  const ext = path.extname(ruta).toLowerCase();

  if (ext === '.json') {
    try {
      JSON.parse(contenido);
      return { ok: true, detalle: 'JSON valido' };
    } catch (err) {
      return { ok: false, detalle: 'JSON invalido: ' + err.message };
    }
  }

  if (['.js', '.cjs', '.mjs'].includes(ext)) {
    try {
      new vm.Script(contenido, { filename: ruta });
      return { ok: true, detalle: 'sintaxis JavaScript valida' };
    } catch (err) {
      // vm.Script no entiende import/export: eso no es un error del agente
      if (/import|export/.test(err.message) || /Cannot use import/.test(err.message)) {
        return { ok: null, detalle: 'modulo ES: no se pudo comprobar la sintaxis aqui' };
      }
      return { ok: false, detalle: 'error de sintaxis: ' + err.message };
    }
  }

  return { ok: null, detalle: 'sin comprobacion automatica para este tipo de archivo' };
}

/**
 * Escribe el resultado de un agente en el proyecto. Si el archivo ya existia,
 * guarda una copia en la carpeta de GCenter (no en el proyecto, para no
 * ensuciarlo) por si hay que deshacer.
 */
function escribirResultado(rel, texto) {
  const abs = resolver(rel);
  const contenido = extraerArchivo(texto);
  const existia = fs.existsSync(abs);
  let copia = null;

  if (existia) {
    const sello = new Date().toISOString().replace(/[:.]/g, '-');
    copia = path.join(config.configDir(), 'backups', sello, rel);
    fs.mkdirSync(path.dirname(copia), { recursive: true });
    fs.copyFileSync(abs, copia);
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contenido, 'utf8');

  const lineas = contenido.split('\n');
  const sintaxis = comprobarSintaxis(rel, contenido);

  return {
    ruta: rel,
    accion: existia ? 'sobrescrito' : 'creado',
    lineas: lineas.length,
    bytes: Buffer.byteLength(contenido),
    copia,
    sintaxis,
    // Un vistazo al principio y al final basta para saber si el archivo tiene
    // la forma esperada, sin que Claude tenga que leerlo entero
    inicio: lineas.slice(0, 12).join('\n'),
    final: lineas.length > 20 ? lineas.slice(-5).join('\n') : ''
  };
}

/**
 * Los modos que piden supervision explicita no deben ver archivos cambiados
 * por la puerta de atras: en ellos el agente devuelve el texto y Claude decide.
 */
function escrituraPermitida() {
  const modo = config.load().permissionMode || 'acceptEdits';
  return !['plan', 'manual', 'dontAsk'].includes(modo);
}

module.exports = {
  raiz,
  resolver,
  leerContexto,
  extraerArchivo,
  comprobarSintaxis,
  escribirResultado,
  escrituraPermitida
};
