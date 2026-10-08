'use strict';

/**
 * Control de calidad de lo que devuelven los agentes.
 *
 * Los modelos gratuitos fallan de maneras que no producen un error HTTP: se
 * repiten en bucle, devuelven el enunciado de vuelta, se niegan a trabajar, o
 * cortan a mitad de frase. Todo eso llega como un 200 perfectamente valido.
 *
 * Estas comprobaciones son deliberadamente CONSERVADORAS. Marcar como mala una
 * respuesta correcta es peor que dejar pasar una mediocre: el jefe la va a
 * revisar igualmente, y una alarma que salta sin motivo se acaba ignorando.
 * Por eso solo se senalan patrones inequivocos.
 */

/** Negativas explicitas. Solo cuentan si son casi toda la respuesta. */
const NEGATIVAS = /\b(no puedo (ayudar|asistir|hacer|proporcionar)|lo siento,? (pero )?no|i (cannot|can't|am unable to)|i'm sorry,? (but )?i)\b/i;

/** Restos del andamiaje interno del modelo que no deberian salir. */
const FUGAS = /<\/?(think|thinking|reasoning|scratchpad)>|^\s*(assistant|user|system)\s*:/im;

/** Detecta si el modelo se quedo atascado repitiendo el mismo fragmento. */
function repeticionDegenerada(texto) {
  if (texto.length < 200) return false;

  // Buscamos un fragmento de 40 caracteres que aparezca muchas veces
  const muestra = texto.slice(Math.floor(texto.length / 3), Math.floor(texto.length / 3) + 40);
  if (muestra.trim().length < 30) return false;

  let veces = 0;
  let desde = 0;
  while (true) {
    const i = texto.indexOf(muestra, desde);
    if (i === -1) break;
    veces += 1;
    desde = i + 1;
    if (veces >= 4) return true;
  }
  return false;
}

/** Mide cuanto de la respuesta es texto copiado literalmente del enunciado. */
function proporcionCopiada(texto, prompt) {
  if (!prompt || texto.length < 60) return 0;

  const lineas = texto.split(/\n/).filter((l) => l.trim().length > 25);
  if (!lineas.length) return 0;

  const copiadas = lineas.filter((l) => prompt.includes(l.trim()));
  return copiadas.length / lineas.length;
}

/**
 * Evalua una respuesta.
 *
 * @param {object} r  { text, finishReason, prompt, maxTokens }
 * @returns {{ ok: boolean, gravedad: 'ninguna'|'aviso'|'grave', problemas: string[] }}
 */
function evaluar(r) {
  const texto = String(r.text || '');
  const limpio = texto.trim();
  const problemas = [];
  let grave = false;

  if (!limpio) {
    return { ok: false, gravedad: 'grave', problemas: ['respuesta vacia'] };
  }

  // Una respuesta de dos palabras a una tarea que pedia trabajo de verdad
  if (limpio.length < 40 && (r.maxTokens || 0) > 512) {
    problemas.push('respuesta demasiado corta (' + limpio.length + ' caracteres) para la tarea pedida');
    grave = true;
  }

  if (repeticionDegenerada(limpio)) {
    problemas.push('el modelo se atasco repitiendo el mismo fragmento');
    grave = true;
  }

  const copiado = proporcionCopiada(limpio, r.prompt);
  if (copiado > 0.6) {
    problemas.push('devuelve mayoritariamente el enunciado copiado, no trabajo nuevo');
    grave = true;
  }

  // Una negativa solo es sospechosa si ocupa practicamente toda la respuesta:
  // en una larga puede ser una advertencia legitima de pasada
  if (NEGATIVAS.test(limpio) && limpio.length < 320) {
    problemas.push('el agente se nego a realizar la tarea');
    grave = true;
  }

  if (FUGAS.test(limpio)) {
    problemas.push('se filtro el andamiaje interno del modelo (etiquetas de pensamiento o de rol)');
  }

  if (r.finishReason === 'length') {
    problemas.push('la respuesta quedo cortada por el limite de tokens');
  }

  if (!problemas.length) return { ok: true, gravedad: 'ninguna', problemas: [] };
  return { ok: !grave, gravedad: grave ? 'grave' : 'aviso', problemas };
}

module.exports = { evaluar };
