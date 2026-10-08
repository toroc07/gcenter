'use strict';

/**
 * Sustituto del preload real para generar la captura del README.
 *
 * Expone la misma API `window.gcenter` que espera la interfaz, pero alimentada
 * con datos de demostracion: ninguna ruta, sesion ni llave real aparece en la
 * imagen. La interfaz que se renderiza es la de verdad (mismo HTML, CSS y JS).
 */

const { contextBridge } = require('electron');

const manejadores = {};
const emitir = (canal, datos) => (manejadores[canal] || []).forEach((h) => h(datos));

const CWD = 'C:\\proyectos\\calculadora';

const NARANJA = '\x1b[38;5;209m';
const GRIS = '\x1b[38;5;245m';
const BLANCO = '\x1b[97m';
const VERDE = '\x1b[38;5;108m';
const FIN = '\x1b[0m';

const TRANSCRIPCION = [
  '',
  GRIS + '> ' + FIN + 'crea una calculadora cientifica de escritorio',
  '',
  NARANJA + '●' + FIN + ' Diseno la estructura y fijo el contrato entre los archivos.',
  '',
  VERDE + '●' + FIN + ' ' + BLANCO + 'Write' + FIN + '(CONTRATO.md)',
  GRIS + '  └ 24 lineas' + FIN,
  VERDE + '●' + FIN + ' ' + BLANCO + 'Write' + FIN + '(package.json)',
  GRIS + '  └ 19 lineas' + FIN,
  '',
  NARANJA + '●' + FIN + ' ' + BLANCO + 'gcenter' + FIN + ' · delegate_parallel ' + GRIS + '(5 agentes)' + FIN,
  GRIS + '  └ MOTOR    codigo  → calc.js' + FIN,
  GRIS + '    UI       codigo  → index.html' + FIN,
  GRIS + '    ESTILOS  codigo  → styles.css' + FIN,
  GRIS + '    APP      codigo  → app.js' + FIN,
  GRIS + '    MAIN     rapido  → main.js' + FIN,
  '',
  GRIS + '  MAIN  → main.js     28 lineas · sintaxis OK' + FIN,
  GRIS + '  UI    → index.html  96 lineas' + FIN,
  '',
  NARANJA + '✻' + FIN + ' Esperando al equipo… ' + GRIS + '(23s)' + FIN,
  ''
].join('\r\n');

const PROVEEDORES = [
  { id: 'groq', label: 'Groq', hasKey: true },
  { id: 'gemini', label: 'Google Gemini', hasKey: true },
  { id: 'openrouter', label: 'OpenRouter', hasKey: true },
  { id: 'nvidia', label: 'NVIDIA NIM', hasKey: true },
  { id: 'mistral', label: 'Mistral', hasKey: false }
].map((p) => Object.assign({ free: '', strengths: '', signupUrl: '', keyName: '', color: '#888' }, p));

function agente(id, role, provider, label, model, haceMs) {
  return { id, role, provider, providerLabel: label, model, startedAt: Date.now() - haceMs, task: '' };
}

/** Reproduce un instante a mitad de un lote paralelo. */
function representar() {
  emitir('session:started', { cwd: CWD, model: 'opus' });
  emitir('session:data', TRANSCRIPCION);

  const ev = (e) => emitir('agents:event', e);

  ev({ type: 'agent.start', agent: agente('a1', 'MAIN', 'groq', 'Groq', 'openai/gpt-oss-20b', 23000) });
  ev({ type: 'agent.start', agent: agente('a2', 'UI', 'groq', 'Groq', 'qwen/qwen3.8-27b', 23000) });
  ev({ type: 'agent.done', id: 'a1', elapsedMs: 900, tokensOut: 412, chars: 1210 });
  ev({ type: 'agent.done', id: 'a2', elapsedMs: 2100, tokensOut: 1830, chars: 4120 });

  ev({ type: 'agent.start', agent: agente('a3', 'ESTILOS', 'openrouter', 'OpenRouter', 'poolside/laguna-s-2.1:free', 23000) });
  ev({ type: 'agent.start', agent: agente('a4', 'APP', 'openrouter', 'OpenRouter', 'cohere/north-mini-code:free', 23000) });
  ev({ type: 'agent.progress', id: 'a3', chars: 2380 });
  ev({ type: 'agent.progress', id: 'a4', chars: 1640 });

  ev({ type: 'agent.start', agent: agente('a5', 'MOTOR', 'nvidia', 'NVIDIA NIM', 'moonshotai/kimi-k3', 23000) });
  ev({ type: 'agent.progress', id: 'a5', chars: 3120, thinking: true });

  ev({ type: 'stats', stats: { delegations: 5, completed: 2, failed: 0, tokensIn: 6900, tokensOut: 2242 } });
  ev({
    type: 'health',
    proveedores: [
      { providerId: 'groq', nivel: 'sano', ok: 2, fallos: 0, fiabilidad: 100 },
      { providerId: 'openrouter', nivel: 'sano', ok: 6, fallos: 0, fiabilidad: 100 },
      { providerId: 'nvidia', nivel: 'sano', ok: 3, fallos: 0, fiabilidad: 100 },
      { providerId: 'gemini', nivel: 'sano', ok: 4, fallos: 0, fiabilidad: 100 }
    ]
  });

  // Desplegamos el grupo de OpenRouter para que se vean sus dos modelos
  setTimeout(() => {
    const cabeceras = document.querySelectorAll('.agent-card.grouped .agent-head');
    for (const c of cabeceras) {
      if (/OpenRouter/i.test(c.textContent)) c.click();
    }
  }, 300);
}

contextBridge.exposeInMainWorld('gcenter', {
  win: { minimize() {}, maximize() {}, close() {} },
  session: {
    start: async () => {
      setTimeout(representar, 200);
      return true;
    },
    stop: async () => {},
    restart: async () => true,
    write: async () => {},
    resize: async () => {},
    status: async () => ({ running: true }),
    setModel: async () => ({ running: true }),
    setEffort: async () => ({ running: true }),
    setPermissionMode: async () => true
  },
  config: {
    get: async () => ({
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
      theme: 'dark',
      cwd: CWD,
      recentDirs: [],
      keys: {},
      freeOnly: true
    }),
    set: async () => true,
    setKey: async () => true
  },
  dir: { choose: async () => null, set: async () => ({ ok: false }) },
  providers: { list: async () => PROVEEDORES, check: async () => ({ ok: true }) },
  openExternal: async () => {},
  on: (canal, h) => {
    (manejadores[canal] = manejadores[canal] || []).push(h);
    return () => {};
  }
});
