'use strict';

/**
 * Sondea que modelos gratuitos de OpenRouter son realmente utilizables.
 *
 * OpenRouter reserva parte de su catalogo gratuito a aplicaciones registradas
 * en su directorio, y no lo indica en ningun campo del catalogo: solo se
 * descubre al recibir un 403. Esto lo comprueba de una vez y deja apuntados los
 * restringidos en la configuracion, para que GCenter no vuelva a ofrecerlos.
 *
 *   node tools/probe-openrouter.js
 *
 * AVISO: gasta una peticion por modelo de tu cuota diaria (50/dia sin creditos),
 * pero pide un solo token, asi que no consume presupuesto de generacion.
 */

const providers = require('../src/mcp/providers');
const config = require('../src/shared/config');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[92m', red: '\x1b[91m', yellow: '\x1b[93m' };

(async () => {
  const key = config.apiKeyFor('openrouter', 'OPENROUTER_API_KEY');
  if (!key) {
    console.error('No hay API key de OpenRouter configurada.');
    process.exit(1);
  }

  const catalog = await providers.fetchModels('openrouter', key, { force: true });
  if (!catalog.ok) {
    console.error('No pude listar el catalogo:', catalog.error);
    process.exit(1);
  }

  console.log('');
  console.log(C.bold + '  Sondeando ' + catalog.models.length + ' modelos gratuitos de OpenRouter' + C.reset);
  console.log(C.dim + '  Una peticion de 1 token por modelo.' + C.reset);
  console.log('');

  const usables = [];
  const restringidos = [];
  const otros = [];

  for (const model of catalog.models) {
    process.stdout.write('  ' + C.dim + model.padEnd(48) + C.reset);
    try {
      await providers.chat({
        providerId: 'openrouter',
        apiKey: key,
        model,
        prompt: 'hola',
        maxTokens: 64,
        timeoutMs: 45000
      });
      usables.push(model);
      console.log(C.green + 'USABLE' + C.reset);
    } catch (err) {
      const msg = err.message;
      if (/reserva a aplicaciones|agentic harness|only available/i.test(msg)) {
        restringidos.push(model);
        console.log(C.red + 'RESTRINGIDO' + C.reset);
      } else if (/Cuota .* agotada|429/.test(msg)) {
        console.log(C.yellow + 'CUOTA AGOTADA — paro aqui' + C.reset);
        break;
      } else {
        otros.push([model, msg.slice(0, 70)]);
        console.log(C.yellow + 'OTRO: ' + msg.slice(0, 60) + C.reset);
      }
    }
  }

  console.log('');
  console.log(C.bold + '  Resumen' + C.reset);
  console.log('    ' + C.green + usables.length + ' usables' + C.reset +
    '   ' + C.red + restringidos.length + ' restringidos' + C.reset +
    '   ' + C.yellow + otros.length + ' con otros errores' + C.reset);

  if (usables.length) {
    console.log('');
    console.log('  Utilizables de verdad:');
    for (const m of usables) console.log('    ' + C.green + m + C.reset);
  }

  const guardados = config.load().restrictedModels || [];
  console.log('');
  console.log(C.dim + '  Apuntados en la configuracion: ' + guardados.length + ' modelos restringidos.' + C.reset);
  console.log(C.dim + '  GCenter dejara de ofrecerlos automaticamente.' + C.reset);
  console.log('');
})();
