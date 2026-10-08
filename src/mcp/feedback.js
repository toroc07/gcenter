'use strict';

/**
 * Valoraciones de calidad que el jefe da a cada modelo.
 *
 * El control de calidad automatico solo atrapa la basura evidente (repeticion,
 * eco del enunciado, negativas). Que un codigo este MAL escrito solo lo sabe
 * quien lo revisa: Claude. Aqui guardamos ese juicio, por modelo, y lo usamos
 * para ordenar el reparto. Se persiste entre sesiones porque es exactamente el
 * tipo de cosa que no conviene volver a aprender cada vez.
 */

const fs = require('fs');
const path = require('path');
const config = require('../shared/config');

const FICHERO = path.join(config.configDir(), 'feedback.json');

let cache = null;

function cargar() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FICHERO, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    cache = {};
  }
  return cache;
}

function guardar() {
  try {
    fs.mkdirSync(path.dirname(FICHERO), { recursive: true });
    fs.writeFileSync(FICHERO, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    /* si no se puede guardar, al menos vale para esta sesion */
  }
}

function clave(provider, model) {
  return provider + '|' + model;
}

/**
 * @param {'bueno'|'regular'|'malo'} nota
 */
function valorar(provider, model, nota, motivo) {
  const datos = cargar();
  const k = clave(provider, model);
  const f = datos[k] || { bueno: 0, regular: 0, malo: 0, ultimos: [] };

  f[nota] = (f[nota] || 0) + 1;
  f.ultimos = [{ nota, motivo: String(motivo || '').slice(0, 200), en: Date.now() }]
    .concat(f.ultimos || [])
    .slice(0, 5);

  datos[k] = f;
  guardar();
  return f;
}

/**
 * Puntuacion para ordenar candidatos. Un "malo" pesa el doble que un "bueno":
 * un modelo que la mitad de las veces hay que rehacer sale mas caro que no
 * tenerlo, porque cada rehacer lo paga Claude.
 */
function puntuacion(provider, model) {
  const f = cargar()[clave(provider, model)];
  if (!f) return 0;
  return (f.bueno || 0) - 2 * (f.malo || 0);
}

/**
 * Un modelo que acumula varios suspensos y ningun aprobado se aparta del
 * reparto automatico. Sigue disponible si Claude lo pide a mano.
 */
function vetado(provider, model) {
  const f = cargar()[clave(provider, model)];
  return Boolean(f && (f.malo || 0) >= 3 && !(f.bueno || 0));
}

function ficha(provider, model) {
  return cargar()[clave(provider, model)] || null;
}

function todo() {
  return Object.assign({}, cargar());
}

module.exports = { valorar, puntuacion, vetado, ficha, todo };
