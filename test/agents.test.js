'use strict';

/**
 * Pruebas de los agentes del usuario, sin red y sin cuentas de nadie.
 *
 * Todo corre contra una carpeta de configuracion temporal, con llaves falsas y
 * un `fetch` simulado que hace de proveedor. Comprueba:
 *
 *   1. la deteccion del proveedor por nombre y por prefijo de la llave
 *   2. la migracion de las llaves de la version 1 a agentes
 *   3. las decisiones del filtro de gratuidad, con y sin filtro, incluidos los
 *      proveedores propios que publican precios y los que no
 *   4. el reparto por capacidades con agentes propios
 *
 *   node test/agents.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gcenter-agents-'));
process.env.GCENTER_HOME = home;
const CONFIG = path.join(home, 'config.json');

function escribirConfig(obj) {
  fs.writeFileSync(CONFIG, JSON.stringify(obj));
}

/* Proveedores simulados: cada URL base responde con su catalogo */
const CATALOGOS = {
  'https://api.groq.com/openai/v1': [{ id: 'openai/gpt-oss-120b' }, { id: 'qwen/qwen3.8-32b' }, { id: 'whisper-large-v3' }],
  'https://precios.example/v1': [
    { id: 'gratis-1', pricing: { prompt: '0', completion: '0' } },
    { id: 'caro-1', pricing: { prompt: '0.000002', completion: '0.000008' } }
  ],
  'https://opaco.example/v1': [{ id: 'modelo-a' }, { id: 'modelo-b-2' }]
};

global.fetch = async (url) => {
  const base = String(url).replace(/\/models$/, '');
  const data = CATALOGOS[base];
  if (!data) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  return { ok: true, status: 200, json: async () => ({ data }) };
};

let fallos = 0;
function caso(nombre, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log('  \x1b[92m✓\x1b[0m ' + nombre))
    .catch((e) => {
      fallos += 1;
      console.log('  \x1b[91m✕ ' + nombre + '\x1b[0m\n      ' + e.message);
    });
}

async function main() {
  console.log('\n  AGENTES DEL USUARIO\n');

  // La migracion tiene que correr antes de que nadie cargue la configuracion
  escribirConfig({ keys: { groq: 'gsk_falsa', gemini: '', nvidia: 'nvapi-falsa' }, freeOnly: true });
  const config = require('../src/shared/config');

  await caso('migra las llaves de la v1 a agentes, conservando los ids', () => {
    const cfg = config.load();
    assert.deepStrictEqual(cfg.agents.map((a) => a.id), ['groq', 'nvidia']);
    assert.strictEqual(cfg.agents[0].kind, 'groq');
    const enDisco = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    assert.ok(!enDisco.keys, 'la configuracion guardada ya no deberia tener "keys"');
    assert.strictEqual(enDisco.agents.length, 2);
  });

  const providers = require('../src/mcp/providers');
  const capabilities = require('../src/mcp/capabilities');

  await caso('detecta el proveedor por el nombre', () => {
    assert.strictEqual(providers.detectar('Groq', ''), 'groq');
    assert.strictEqual(providers.detectar('mi groq personal', ''), 'groq');
    assert.strictEqual(providers.detectar('Google AI Studio', ''), 'gemini');
    assert.strictEqual(providers.detectar('NVIDIA NIM', ''), 'nvidia');
    assert.strictEqual(providers.detectar('Mistral', ''), 'mistral');
  });

  await caso('detecta el proveedor por el prefijo de la llave', () => {
    assert.strictEqual(providers.detectar('trabajo', 'gsk_abc'), 'groq');
    assert.strictEqual(providers.detectar('x', 'sk-or-v1-abc'), 'openrouter');
    assert.strictEqual(providers.detectar('x', 'nvapi-abc'), 'nvidia');
    assert.strictEqual(providers.detectar('x', 'AIzaSyabc'), 'gemini');
  });

  await caso('un proveedor desconocido pide URL', () => {
    assert.strictEqual(providers.detectar('Mi servidor', 'abc123'), null);
  });

  await caso('los ids no se repiten', () => {
    assert.strictEqual(providers.idLibre('Groq', ['groq']), 'groq-2');
    assert.strictEqual(providers.idLibre('Mi Groq #2', []), 'mi-groq-2');
  });

  // A partir de aqui, una configuracion con agentes de los tres tipos
  escribirConfig({
    freeOnly: true,
    agents: [
      { id: 'groq', name: 'Groq', kind: 'groq', key: 'gsk_falsa' },
      { id: 'precios', name: 'Con precios', kind: 'custom', key: 'k', baseUrl: 'https://precios.example/v1/' },
      { id: 'opaco', name: 'Sin precios', kind: 'custom', key: 'k', baseUrl: 'https://opaco.example/v1' }
    ]
  });
  const agente = (id) => providers.getAgent(id);

  await caso('plantilla conocida: todo gratis menos lo que no es chat', async () => {
    const r = await providers.fetchModels(agente('groq'), { force: true });
    assert.deepStrictEqual(r.models.sort(), ['openai/gpt-oss-120b', 'qwen/qwen3.8-32b']);
    assert.ok((await providers.checkFree(agente('groq'), 'openai/gpt-oss-120b')).ok);
  });

  await caso('proveedor propio con precios: solo los que cuestan cero', async () => {
    const r = await providers.fetchModels(agente('precios'), { force: true });
    assert.deepStrictEqual(r.models, ['gratis-1']);
    assert.strictEqual(r.verificable, true);
    assert.ok((await providers.checkFree(agente('precios'), 'gratis-1')).ok);
    assert.ok(!(await providers.checkFree(agente('precios'), 'caro-1')).ok);
  });

  await caso('proveedor propio sin precios: bloqueado con el filtro activo', async () => {
    const r = await providers.fetchModels(agente('opaco'), { force: true });
    assert.strictEqual(r.bloqueado, true);
    assert.deepStrictEqual(r.models, []);
    const v = await providers.checkFree(agente('opaco'), 'modelo-a');
    assert.ok(!v.ok && /no se puede comprobar/.test(v.reason));
  });

  await caso('sin filtro: se ofrecen todos los modelos de chat', async () => {
    const opaco = await providers.fetchModels(agente('opaco'), { freeOnly: false });
    assert.deepStrictEqual(opaco.models.sort(), ['modelo-a', 'modelo-b-2']);
    const precios = await providers.fetchModels(agente('precios'), { freeOnly: false });
    assert.deepStrictEqual(precios.models.sort(), ['caro-1', 'gratis-1']);
  });

  await caso('reparto con el filtro: el agente opaco no recibe trabajo', async () => {
    const lista = await capabilities.candidatos('codigo');
    const ids = new Set(lista.map((c) => c.provider));
    assert.ok(ids.has('groq'), 'groq deberia cubrir codigo');
    assert.ok(ids.has('precios'), 'el agente con precios entra como generalista');
    assert.ok(!ids.has('opaco'), 'el agente sin precios no deberia recibir trabajo');
    assert.strictEqual(lista[0].provider, 'groq', 'el especialista va antes que el generalista');
  });

  await caso('reparto sin filtro: el agente opaco entra como generalista', async () => {
    escribirConfig(Object.assign(JSON.parse(fs.readFileSync(CONFIG, 'utf8')), { freeOnly: false }));
    const lista = await capabilities.candidatos('redaccion');
    const opaco = lista.find((c) => c.provider === 'opaco');
    assert.ok(opaco, 'deberia aparecer');
    assert.strictEqual(opaco.model, 'modelo-b-2', 'aporta su modelo mas reciente');
  });

  await caso('sin agentes no hay candidatos (le toca al orquestador)', async () => {
    escribirConfig({ freeOnly: true, agents: [] });
    assert.deepStrictEqual(await capabilities.candidatos('codigo'), []);
  });

  fs.rmSync(home, { recursive: true, force: true });
  console.log('\n  ' + (fallos ? '\x1b[91m' + fallos + ' fallos\x1b[0m' : '\x1b[92mTodo correcto\x1b[0m') + '\n');
  process.exit(fallos ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
