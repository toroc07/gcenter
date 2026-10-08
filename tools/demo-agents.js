'use strict';

/**
 * Simula un lote de agentes trabajando, para poder revisar el sidebar sin
 * consumir cuota de ningun proveedor. Requiere que GCenter este abierto.
 *
 *   node tools/demo-agents.js
 */

const WebSocket = require('ws');
const { loadRuntime } = require('../src/shared/config');

const runtime = loadRuntime();
if (!runtime || !runtime.port) {
  console.error('GCenter no esta corriendo (no hay runtime.json)');
  process.exit(1);
}

const ws = new WebSocket('ws://127.0.0.1:' + runtime.port + '/bus?token=' + runtime.token);

const FAKE = [
  { role: 'CODER',      provider: 'groq',       providerLabel: 'Groq',          color: '#f55036', model: 'openai/gpt-oss-120b',       ms: 4200, chars: 2600 },
  { role: 'REASONER',   provider: 'openrouter', providerLabel: 'OpenRouter',    color: '#8b5cf6', model: 'deepseek/deepseek-r1:free', ms: 9500, chars: 4100 },
  { role: 'CONTRASTE',  provider: 'openrouter', providerLabel: 'OpenRouter',    color: '#8b5cf6', model: 'qwen/qwen3-235b-a22b:free', ms: 7200, chars: 3300 },
  { role: 'LONGCTX',    provider: 'gemini',     providerLabel: 'Google Gemini', color: '#4285f4', model: 'gemini-2.5-flash',          ms: 6100, chars: 5200 },
  { role: 'REVIEWER',   provider: 'github',     providerLabel: 'GitHub Models', color: '#a371f7', model: 'openai/gpt-4.1-mini',       ms: 5400, chars: 1800 },
  { role: 'DOC',        provider: 'mistral',    providerLabel: 'Mistral',       color: '#ff7000', model: 'mistral-small-latest',      ms: 3100, chars: 1200 }
];

const stats = { delegations: 0, completed: 0, failed: 0, tokensIn: 0, tokensOut: 0 };

function send(o) {
  ws.send(JSON.stringify(Object.assign({ ts: Date.now() }, o)));
}

ws.on('open', () => {
  console.log('conectado al bus, lanzando ' + FAKE.length + ' agentes simulados...');

  FAKE.forEach((f, i) => {
    const id = 'demo-' + i;
    const startedAt = Date.now();

    send({
      type: 'agent.start',
      agent: {
        id, role: f.role, provider: f.provider, providerLabel: f.providerLabel,
        color: f.color, model: f.model, status: 'running', startedAt,
        chars: 0, task: 'tarea simulada de demostracion'
      }
    });

    stats.delegations += 1;
    send({ type: 'stats', stats: Object.assign({}, stats) });

    // Progreso a saltos, como un stream real
    const steps = 14;
    for (let s = 1; s <= steps; s++) {
      setTimeout(() => {
        send({ type: 'agent.progress', id, chars: Math.round((f.chars * s) / steps) });
      }, (f.ms * s) / steps);
    }

    setTimeout(() => {
      // El ultimo falla a proposito, para ver el estado de error
      if (i === FAKE.length - 1) {
        stats.failed += 1;
        send({ type: 'agent.error', id, role: f.role, error: 'rate limit: 30 req/min agotadas' });
      } else {
        const tokensOut = Math.round(f.chars / 3.6);
        stats.completed += 1;
        stats.tokensIn += Math.round(f.chars / 2);
        stats.tokensOut += tokensOut;
        send({ type: 'agent.done', id, role: f.role, elapsedMs: f.ms, tokensIn: Math.round(f.chars / 2), tokensOut, chars: f.chars });
      }
      send({ type: 'stats', stats: Object.assign({}, stats) });
    }, f.ms);
  });

  const total = Math.max.apply(null, FAKE.map((f) => f.ms)) + 1500;
  setTimeout(() => {
    console.log('demo terminada');
    ws.close();
    process.exit(0);
  }, total);
});

ws.on('error', (e) => {
  console.error('no pude conectar al bus:', e.message);
  process.exit(1);
});
