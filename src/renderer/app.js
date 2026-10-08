/* ══════════════════════════════════════════════════════════════════════
   GCenter — logica de la interfaz
   ════════════════════════════════════════════════════════════════════ */

const api = window.gcenter;

/* Modelos de Claude Code que pueden hacer de jefe. Se usan los alias, que
   siempre apuntan a la ultima version de cada familia. */
/* Los ids son los alias, que Claude Code resuelve siempre a la ultima version
   de cada familia: lo que hay que mantener al dia son solo los nombres
   visibles. Versiones vigentes comprobadas en el propio binario de Claude Code. */
const CLAUDE_MODELS = [
  { id: 'opus',   name: 'Opus 5.5',   tag: 'maximo criterio' },
  { id: 'sonnet', name: 'Sonnet 5.5', tag: 'equilibrado' },
  { id: 'fable',  name: 'Fable 5.1',  tag: 'creativo' },
  { id: 'haiku',  name: 'Haiku 4.5',  tag: 'rapido y barato' }
];

const $ = (id) => document.getElementById(id);

const state = {
  cfg: null,
  providers: [],
  // Los agentes se agrupan por proveedor: un lote paralelo de OpenRouter con
  // dos modelos es UNA tarjeta desplegable, no dos tarjetas repetidas.
  groups: new Map(),      // clave -> ficha del grupo
  agentGroup: new Map(),  // id de agente -> clave de su grupo
  liveGroup: new Map(),   // proveedor -> clave del grupo que sigue abierto
  groupSeq: 0,
  activeCount: 0,
  stats: { delegations: 0, completed: 0, failed: 0, tokensIn: 0, tokensOut: 0 }
};

/* ────────────────────────────── Terminal ───────────────────────────── */

/**
 * Paletas del terminal.
 *
 * No las reducimos a dos colores, aunque la interfaz sea monocroma: ese
 * espacio no es nuestro, es Claude Code quien pinta ahi sus diffs, su sintaxis
 * y sus avisos, y necesita los 16 colores ANSI para distinguirlos. Lo que
 * hacemos es bajarles la saturacion hasta que parezcan tinta y no neon.
 */
const TEMAS = {
  dark: {
    background: '#00000000',
    foreground: '#e8e8e8',
    cursor: '#ff6b35',
    cursorAccent: '#141414',
    selectionBackground: 'rgba(255, 107, 53, 0.25)',

    black: '#2b2b2b',
    red: '#d15b4a',
    green: '#8fae6a',
    yellow: '#d9a441',
    blue: '#6a92c0',
    magenta: '#b07aa8',
    cyan: '#5f9ea0',
    white: '#d0d0d0',

    brightBlack: '#5a5a5a',
    brightRed: '#e07d6d',
    brightGreen: '#a8c488',
    brightYellow: '#e8bf6a',
    brightBlue: '#8badd2',
    brightMagenta: '#c79bc0',
    brightCyan: '#83b5b7',
    brightWhite: '#f5f5f5'
  },

  // En claro hay que oscurecer los colores, no solo invertir el fondo: los
  // tonos pensados para fondo negro quedan ilegibles sobre papel
  light: {
    background: '#00000000',
    foreground: '#1f1f1f',
    cursor: '#c2410c',
    cursorAccent: '#faf9f7',
    selectionBackground: 'rgba(194, 65, 12, 0.18)',

    black: '#3a3a3a',
    red: '#a8332a',
    green: '#4a6b2f',
    yellow: '#8a6410',
    blue: '#2d5b8a',
    magenta: '#7c3f74',
    cyan: '#2f6668',
    white: '#5a5a5a',

    brightBlack: '#8a8a8a',
    brightRed: '#c4453a',
    brightGreen: '#5e854a',
    brightYellow: '#a87c1c',
    brightBlue: '#3f74a8',
    brightMagenta: '#96548c',
    brightCyan: '#3f8285',
    brightWhite: '#2b2b2b'
  }
};

const term = new Terminal({
  fontFamily: '"Cascadia Code", "Cascadia Mono", "JetBrains Mono", Consolas, "Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono", monospace',
  fontSize: 13.5,
  lineHeight: 1.25,
  letterSpacing: 0,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 12000,
  allowProposedApi: true,
  macOptionIsMeta: true,
  theme: TEMAS.dark,
  allowTransparency: true
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => api.openExternal(uri)));
term.open($('term'));

function fit() {
  try {
    fitAddon.fit();
    api.session.resize(term.cols, term.rows);
  } catch (e) {
    /* la ventana puede estar minimizada */
  }
}

new ResizeObserver(fit).observe($('term'));
window.addEventListener('resize', fit);

term.onData((d) => api.session.write(d));

/* Atajos propios de GCenter. Todo lo demas se lo lleva Claude tal cual. */
term.attachCustomKeyEventHandler((ev) => {
  if (ev.type !== 'keydown') return true;

  if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
    const sel = term.getSelection();
    if (sel) navigator.clipboard.writeText(sel);
    return false;
  }
  if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') {
    navigator.clipboard.readText().then((t) => t && api.session.write(t));
    return false;
  }
  if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyR') {
    restartSession();
    return false;
  }
  return true;
});

function banner(lines) {
  for (const l of lines) term.writeln(l);
}

/* ───────────────────────── Estado de la sesion ─────────────────────── */

function setSessionState(kind, label) {
  $('sessionDot').className = 'dot dot-' + kind;
  $('sessionLabel').textContent = label;
}

/**
 * Devuelve el teclado al terminal. Al pulsar cualquier control del panel
 * lateral el foco se quedaba en el, y lo que se escribia despues no llegaba a
 * Claude: parecia que el terminal se habia colgado.
 */
function volverAlTerminal() {
  setTimeout(() => term.focus(), 0);
}

async function restartSession() {
  // Limpiamos antes de arrancar la sesion nueva: la interfaz de Claude se
  // dibuja posicionando el cursor, y si quedan restos de la anterior se mezclan
  // los dos fotogramas en un amasijo ilegible
  term.reset();
  term.writeln('\x1b[38;5;245m── sesion reiniciada en ' + (state.cfg ? state.cfg.cwd : '') + ' ──\x1b[0m\r\n');
  setSessionState('busy', 'reiniciando');
  await api.session.restart();
  setTimeout(fit, 260);
  volverAlTerminal();
}

api.on('session:data', (d) => term.write(d));

api.on('session:started', (info) => {
  setSessionState('on', 'claude activo');
  $('sbModel').textContent = info.model;
  $('sbCwd').textContent = info.cwd;
  setTimeout(fit, 200);
});

api.on('session:exit', ({ exitCode }) => {
  setSessionState('off', 'sesion cerrada');
  term.writeln(
    '\r\n\x1b[38;5;245m── la sesion de Claude termino (codigo ' + exitCode + ') ──\x1b[0m'
  );
  term.writeln('\x1b[38;5;245m   Ctrl+Shift+R para arrancar otra.\x1b[0m\r\n');
});

api.on('session:error', ({ message }) => {
  setSessionState('err', 'error');
  term.writeln('\r\n\x1b[91m[GCenter] ' + message + '\x1b[0m\r\n');
});

/* ───────────────────────── Selector de modelo ──────────────────────── */

function renderModels() {
  const host = $('modelList');
  host.innerHTML = '';

  for (const m of CLAUDE_MODELS) {
    const el = document.createElement('div');
    el.className = 'model-item' + (m.id === state.cfg.model ? ' active' : '');
    el.innerHTML =
      '<span class="model-radio"></span>' +
      '<span class="model-name"></span>' +
      '<span class="model-tag"></span>';
    el.querySelector('.model-name').textContent = m.name;
    el.querySelector('.model-tag').textContent = m.tag;

    el.addEventListener('click', async () => {
      state.cfg.model = m.id;
      renderModels();
      $('sbModel').textContent = m.id;

      const res = await api.session.setModel(m.id);
      // Si no hay sesion, elegir modelo es la senal mas clara de que se quiere
      // trabajar: arrancamos una con ese modelo en vez de solo apuntarlo
      if (!res.running) await restartSession();
      volverAlTerminal();
    });

    host.appendChild(el);
  }
}

/* ──────────────────────── Tarjetas de agentes ──────────────────────── */

function fmtSecs(ms) {
  return (ms / 1000).toFixed(1) + 's';
}

function updateAgentCount() {
  $('agentCount').textContent =
    state.activeCount + (state.activeCount === 1 ? ' activo' : ' activos');
  $('sbAgents').textContent = state.activeCount;
  if (state.activeCount > 0) setSessionState('busy', state.activeCount + ' agentes trabajando');
  else if ($('sessionDot').className.includes('busy')) setSessionState('on', 'claude activo');
}

/** Crea la tarjeta de un grupo y la coloca arriba del panel. */
function crearGrupo(clave, a) {
  const list = $('agentList');
  const note = list.querySelector('.empty-note');
  if (note) note.remove();

  const el = document.createElement('div');
  el.className = 'agent-card running';
  el.innerHTML =
    '<div class="agent-head">' +
      '<span class="agent-caret" hidden>&#9654;</span>' +
      '<span class="agent-role"></span>' +
      '<span class="agent-time">0.0s</span>' +
    '</div>' +
    '<div class="agent-model"></div>' +
    '<div class="agent-meter"><i></i></div>' +
    '<div class="agent-foot"></div>' +
    '<div class="agent-children" hidden></div>';

  list.prepend(el);

  const g = {
    clave,
    providerId: a.provider,
    providerLabel: a.providerLabel,
    startedAt: a.startedAt,
    abierto: false,
    hijos: new Map(),
    el,
    roleEl: el.querySelector('.agent-role'),
    timeEl: el.querySelector('.agent-time'),
    modelEl: el.querySelector('.agent-model'),
    meterEl: el.querySelector('.agent-meter > i'),
    footEl: el.querySelector('.agent-foot'),
    caretEl: el.querySelector('.agent-caret'),
    childrenEl: el.querySelector('.agent-children')
  };

  // Reloj en vivo mientras quede alguien trabajando
  g.tick = setInterval(() => {
    if (activos(g)) g.timeEl.textContent = fmtSecs(Date.now() - g.startedAt);
  }, 100);

  el.querySelector('.agent-head').addEventListener('click', () => {
    if (g.hijos.size < 2) return;
    g.abierto = !g.abierto;
    g.el.classList.toggle('open', g.abierto);
    g.childrenEl.hidden = !g.abierto;
  });

  state.groups.set(clave, g);

  // No dejamos crecer la lista indefinidamente
  while (list.children.length > 25) list.lastElementChild.remove();
  return g;
}

function activos(g) {
  let n = 0;
  for (const h of g.hijos.values()) if (h.status === 'running') n += 1;
  return n;
}

/** Fila de un modelo concreto dentro de un grupo desplegado. */
function crearHijo(g, a) {
  const el = document.createElement('div');
  el.className = 'agent-child running';
  el.innerHTML =
    '<div class="child-head">' +
      '<span class="child-role"></span>' +
      '<span class="child-time">0.0s</span>' +
    '</div>' +
    '<div class="child-model"></div>' +
    '<div class="child-meter"><i></i></div>';

  el.querySelector('.child-role').textContent = a.role;
  el.querySelector('.child-model').textContent = a.model;
  el.title = a.task || '';
  g.childrenEl.appendChild(el);

  return {
    id: a.id,
    role: a.role,
    model: a.model,
    startedAt: a.startedAt,
    chars: 0,
    status: 'running',
    el,
    timeEl: el.querySelector('.child-time'),
    modelEl: el.querySelector('.child-model'),
    meterEl: el.querySelector('.child-meter > i')
  };
}

/**
 * Reescribe la cabecera del grupo. Con un solo agente se comporta como la
 * tarjeta de siempre; a partir de dos pasa a ser un desplegable.
 */
function pintarGrupo(g) {
  const hijos = [...g.hijos.values()];
  const varios = hijos.length > 1;

  g.caretEl.hidden = !varios;
  g.el.classList.toggle('grouped', varios);
  g.childrenEl.hidden = !(varios && g.abierto);

  if (varios) {
    g.roleEl.textContent = g.providerLabel;
    g.modelEl.textContent = hijos.length + ' modelos simultaneos';
  } else {
    g.roleEl.textContent = hijos[0].role;
    g.modelEl.textContent = g.providerLabel + ' · ' + hijos[0].model;
    g.modelEl.title = hijos[0].model;
  }

  const corriendo = activos(g);
  const malos = hijos.filter((h) => h.status === 'poor' || h.status === 'error');

  g.el.classList.toggle('running', corriendo > 0);
  g.el.classList.toggle('done', corriendo === 0 && malos.length === 0);
  g.el.classList.toggle('poor', corriendo === 0 && malos.length > 0 && malos.length < hijos.length);
  g.el.classList.toggle('error', corriendo === 0 && malos.length === hijos.length);

  if (corriendo === 0) {
    clearInterval(g.tick);
    const total = hijos.reduce((s, h) => s + (h.elapsedMs || 0), 0);
    g.timeEl.textContent = varios ? fmtSecs(Math.max(...hijos.map((h) => h.elapsedMs || 0))) : fmtSecs(total);
  }

  pintarPie(g, hijos, corriendo);
}

function pintarPie(g, hijos, corriendo) {
  if (corriendo > 0) {
    const chars = hijos.reduce((s, h) => s + h.chars, 0);
    const pensando = hijos.some((h) => h.status === 'running' && h.thinking);
    g.footEl.textContent =
      (pensando ? 'razonando... ' : '') + chars.toLocaleString('es') + ' caracteres';
    g.meterEl.style.width = Math.min(100, (chars / (3000 * hijos.length)) * 100) + '%';
    return;
  }

  g.meterEl.style.width = '100%';
  const fallos = hijos.filter((h) => h.status === 'poor' || h.status === 'error');

  if (fallos.length) {
    g.footEl.textContent = fallos.length === hijos.length
      ? fallos[0].motivo || 'fallo'
      : fallos.length + ' de ' + hijos.length + ' con problemas: ' + (fallos[0].motivo || '');
    return;
  }

  const tokens = hijos.reduce((s, h) => s + (h.tokensOut || 0), 0);
  const chars = hijos.reduce((s, h) => s + h.chars, 0);
  g.footEl.innerHTML =
    '<span>&#10003; ' + tokens.toLocaleString('es') + ' tokens</span>' +
    // Con un solo agente decir "1 agente" no aporta nada; con varios, si
    '<span>' + (hijos.length > 1
      ? hijos.length + ' agentes'
      : chars.toLocaleString('es') + ' caracteres') + '</span>';
}

function agentStart(a) {
  // Mientras el proveedor tenga un grupo abierto, los nuevos agentes se suman
  // a el; cuando todos terminan, el siguiente empieza un grupo nuevo
  let clave = state.liveGroup.get(a.provider);
  let g = clave && state.groups.get(clave);
  if (!g) {
    state.groupSeq += 1;
    clave = a.provider + '#' + state.groupSeq;
    state.liveGroup.set(a.provider, clave);
    g = crearGrupo(clave, a);
  }

  g.hijos.set(a.id, crearHijo(g, a));
  state.agentGroup.set(a.id, clave);
  pintarGrupo(g);

  state.activeCount += 1;
  updateAgentCount();
}

function hijoDe(id) {
  const clave = state.agentGroup.get(id);
  const g = clave && state.groups.get(clave);
  if (!g) return null;
  const h = g.hijos.get(id);
  return h ? { g, h } : null;
}

function agentProgress(id, chars, thinking) {
  const par = hijoDe(id);
  if (!par) return;

  par.h.chars = chars;
  par.h.thinking = Boolean(thinking);
  par.h.timeEl.textContent = fmtSecs(Date.now() - par.h.startedAt);
  par.h.meterEl.style.width = Math.min(100, (chars / 3000) * 100) + '%';

  pintarPie(par.g, [...par.g.hijos.values()], activos(par.g));
}

/** Cierra un agente, bien o mal, y actualiza su grupo. */
function cerrarAgente(id, status, datos) {
  const par = hijoDe(id);
  if (!par) return;

  const { g, h } = par;
  h.status = status;
  h.elapsedMs = datos.elapsedMs || Date.now() - h.startedAt;
  h.tokensOut = datos.tokensOut || 0;
  h.motivo = datos.motivo || null;
  h.thinking = false;

  h.el.className = 'agent-child ' + status;
  h.timeEl.textContent = fmtSecs(h.elapsedMs);
  h.meterEl.style.width = '100%';
  if (h.motivo) h.modelEl.textContent = h.model + ' — ' + h.motivo;

  if (activos(g) === 0 && state.liveGroup.get(g.providerId) === g.clave) {
    state.liveGroup.delete(g.providerId);
  }

  pintarGrupo(g);
  state.activeCount = Math.max(0, state.activeCount - 1);
  updateAgentCount();
}

function agentDone(ev) {
  // El control de calidad puede rechazar una respuesta que tecnicamente llego
  // bien: se marca distinto para que no parezca trabajo aprovechable
  cerrarAgente(ev.id, ev.calidad === 'grave' ? 'poor' : 'done', {
    elapsedMs: ev.elapsedMs,
    tokensOut: ev.tokensOut,
    motivo: ev.calidad === 'grave' ? (ev.problemas || []).join('; ') : null
  });
}

/** Pinta el estado de salud de cada proveedor en el panel EQUIPO. */
function renderHealth(filas) {
  const host = $('healthList');
  const utiles = filas.filter((f) => f.ok + f.fallos > 0);
  if (!utiles.length) return;

  host.innerHTML = '';
  for (const f of utiles) {
    const p = state.providers.find((x) => x.id === f.providerId);
    const row = document.createElement('div');
    row.className = 'health-row health-' + f.nivel;
    row.innerHTML = '<span class="health-dot"></span>' +
      '<span class="health-name"></span><span class="health-meta"></span>';

    row.querySelector('.health-name').textContent = p ? p.label : f.providerId;

    let meta = f.fiabilidad + '% · ' + f.ok + '/' + (f.ok + f.fallos);
    if (f.nivel === 'agotado') meta = (f.motivoAgotado || 'agotado') + ' · ' + f.minutosParaReintentar + ' min';
    else if (f.nivel === 'degradado') meta = 'degradado · ' + meta;
    row.querySelector('.health-meta').textContent = meta;
    row.title = f.ultimoError || '';

    host.appendChild(row);
  }
}

function agentError(ev) {
  cerrarAgente(ev.id, 'error', { motivo: ev.error });
}

function renderStats(s) {
  state.stats = s;
  $('stDeleg').textContent = s.delegations;
  $('stOk').textContent = s.completed;
  $('stFail').textContent = s.failed;

  const saved = (s.tokensIn || 0) + (s.tokensOut || 0);
  $('stTokens').textContent =
    saved >= 1000 ? (saved / 1000).toFixed(1) + 'k' : String(saved);
}

api.on('agents:event', (ev) => {
  switch (ev.type) {
    case 'agent.start':    agentStart(ev.agent); break;
    case 'agent.progress': agentProgress(ev.id, ev.chars, ev.thinking); break;
    case 'agent.done':     agentDone(ev); break;
    case 'agent.error':    agentError(ev); break;
    case 'stats':          renderStats(ev.stats); break;
    case 'health':         renderHealth(ev.proveedores); break;
    default: break;
  }
});

/* ────────────────────── Directorio de trabajo ──────────────────────── */

function renderCwd() {
  $('cwdCurrent').textContent = state.cfg.cwd;
  $('cwdCurrent').title = state.cfg.cwd;
  $('sbCwd').textContent = state.cfg.cwd;
  $('sbCwd').title = state.cfg.cwd;
}

async function applyCwd(dir) {
  const res = await api.dir.set(dir);
  if (!res.ok) {
    term.writeln('\r\n\x1b[91m[GCenter] ' + res.error + '\x1b[0m');
    return;
  }

  state.cfg.cwd = res.cwd;
  state.cfg.recentDirs = res.recentDirs;
  renderCwd();
  renderRecent();
  $('recentList').hidden = true;

  // restartSession ya limpia la pantalla e indica la carpeta nueva
  await restartSession();
}

function renderRecent() {
  const host = $('recentList');
  host.innerHTML = '';

  const dirs = (state.cfg.recentDirs || []).filter((d) => d !== state.cfg.cwd);
  if (!dirs.length) {
    const p = document.createElement('div');
    p.className = 'recent-item';
    p.textContent = 'Sin carpetas recientes todavia';
    host.appendChild(p);
    return;
  }

  for (const d of dirs) {
    const item = document.createElement('div');
    item.className = 'recent-item';
    item.textContent = d;
    item.title = d;
    item.addEventListener('click', () => applyCwd(d));
    host.appendChild(item);
  }
}

$('btnChooseDir').addEventListener('click', async () => {
  const dir = await api.dir.choose();
  if (dir) applyCwd(dir);
});

$('btnRecentDir').addEventListener('click', () => {
  const host = $('recentList');
  host.hidden = !host.hidden;
  if (!host.hidden) renderRecent();
});

/* ───────────────────────── Ajustes / API keys ──────────────────────── */

function renderProviders() {
  const host = $('providerList');
  host.innerHTML = '';

  for (const p of state.providers) {
    const box = document.createElement('div');
    box.className = 'provider';
    box.innerHTML =
      '<div class="provider-head">' +
        '<span class="provider-name"></span>' +
        '<span class="provider-badge"></span>' +
        '<a class="provider-link">conseguir llave gratis &rarr;</a>' +
      '</div>' +
      '<p class="provider-meta"></p>' +
      '<div class="provider-input">' +
        '<input type="password" spellcheck="false" />' +
        '<button class="btn">Probar</button>' +
      '</div>' +
      '<div class="check-result"></div>';

    const nameEl = box.querySelector('.provider-name');
    nameEl.textContent = p.label;
    nameEl.style.color = p.color;

    const badge = box.querySelector('.provider-badge');
    badge.textContent = p.hasKey ? (p.fromEnv ? 'ENV' : 'ACTIVO') : 'SIN LLAVE';
    badge.className = 'provider-badge ' + (p.hasKey ? 'badge-on' : 'badge-off');

    box.querySelector('.provider-meta').textContent = p.free + '  —  ' + p.strengths;

    const link = box.querySelector('.provider-link');
    link.addEventListener('click', () => api.openExternal(p.signupUrl));

    const input = box.querySelector('input');
    input.placeholder = p.hasKey ? state.cfg.keys[p.id] || 'llave guardada' : p.keyName;
    input.dataset.provider = p.id;

    const result = box.querySelector('.check-result');
    box.querySelector('button').addEventListener('click', async () => {
      const value = input.value.trim();
      if (value) {
        await api.config.setKey(p.id, value);
        input.value = '';
        input.placeholder = 'llave guardada';
      }

      result.textContent = 'comprobando...';
      result.className = 'check-result';

      const res = await api.providers.check(p.id);
      if (res.ok) {
        result.textContent = '✓ conectado — ' + res.count + ' modelos disponibles';
        result.className = 'check-result check-ok';
        badge.textContent = 'ACTIVO';
        badge.className = 'provider-badge badge-on';
      } else {
        result.textContent = '✕ ' + (res.error || 'no responde');
        result.className = 'check-result check-err';
      }
    });

    host.appendChild(box);
  }
}

$('btnSettings').addEventListener('click', async () => {
  state.providers = await api.providers.list();
  state.cfg = await api.config.get();
  renderProviders();
  $('freeOnly').checked = state.cfg.freeOnly !== false;
  $('settingsOverlay').hidden = false;
});

$('btnCloseSettings').addEventListener('click', () => {
  $('settingsOverlay').hidden = true;
  volverAlTerminal();
});

$('settingsOverlay').addEventListener('click', (e) => {
  if (e.target === $('settingsOverlay')) {
    $('settingsOverlay').hidden = true;
    volverAlTerminal();
  }
});

$('btnSaveSettings').addEventListener('click', async () => {
  // Guardamos cualquier llave escrita que no se haya probado
  for (const input of document.querySelectorAll('.provider-input input')) {
    const value = input.value.trim();
    if (value) await api.config.setKey(input.dataset.provider, value);
  }

  await api.config.set({ freeOnly: $('freeOnly').checked });
  state.cfg = await api.config.get();

  $('settingsOverlay').hidden = true;
  await restartSession();
});

/* ──────────────────────── Modo claro / oscuro ──────────────────────── */

function aplicarTema(modo) {
  const claro = modo === 'light';
  document.body.classList.toggle('light', claro);
  term.options.theme = claro ? TEMAS.light : TEMAS.dark;
  $('btnTheme').title = claro ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro';
}

$('btnTheme').addEventListener('click', async () => {
  const modo = document.body.classList.contains('light') ? 'dark' : 'light';
  aplicarTema(modo);
  state.cfg.theme = modo;
  await api.config.set({ theme: modo });

  // Claude Code tiene su propio tema y no se entera del nuestro: sus colores
  // estan pensados para el fondo contrario y quedan deslavados
  term.writeln(
    '\r\n\x1b[38;5;245m[GCenter] modo ' + (modo === 'light' ? 'claro' : 'oscuro') +
    '. Ejecuta \x1b[0m/theme\x1b[38;5;245m para que Claude Code use el suyo a juego.\x1b[0m'
  );
});

/* ─────────────────────── Esfuerzo del modelo ───────────────────────── */

$('effortSel').addEventListener('change', async (e) => {
  const nivel = e.target.value;
  state.cfg.effort = nivel;

  const res = await api.session.setEffort(nivel);

  // Sin sesion la arrancamos ya con el esfuerzo nuevo. Y volver al valor por
  // defecto de Claude no tiene comando en caliente: solo se aplica al relanzar
  if (!res.running || !nivel) await restartSession();
  volverAlTerminal();
});

/* ────────────────────── Modo de permisos de Claude ─────────────────── */

/** Descripciones tomadas literalmente de la ayuda interna de Claude Code. */
const MODOS = {
  plan: 'solo planifica, no ejecuta ninguna herramienta',
  manual: 'pregunta antes de cada accion',
  dontAsk: 'no pregunta; deniega lo que no este aprobado de antemano',
  acceptEdits: 'edita archivos sin preguntar',
  auto: 'un clasificador decide que aprobar y que denegar',
  bypassPermissions: 'se salta todas las comprobaciones de permisos'
};

$('modeSel').addEventListener('change', async (e) => {
  const modo = e.target.value;
  state.cfg.permissionMode = modo;

  // No hay comando para cambiarlo en caliente (solo shift+tab, que cicla y se
  // desincronizaria), asi que se reinicia la sesion reanudando la conversacion.
  // Se limpia la pantalla igual que en cualquier reinicio: si no, los restos
  // de la interfaz anterior se mezclan con la nueva.
  term.reset();
  term.writeln(
    '\x1b[38;5;245m── modo ' + e.target.options[e.target.selectedIndex].text.toLowerCase() +
    ': ' + MODOS[modo] + ' ──\x1b[0m\r\n'
  );
  setSessionState('busy', 'cambiando de modo');
  await api.session.setPermissionMode(modo);
  setTimeout(fit, 260);
  volverAlTerminal();
});

/* ─────────────── El teclado siempre vuelve al terminal ─────────────── */

// Tras usar cualquier control del panel lateral o la barra de titulo, el foco
// regresa al terminal. Se excluyen los desplegables (necesitan el foco mientras
// se elige) y el engranaje (abre el modal, cuyos campos lo necesitan).
for (const zona of [document.querySelector('.sidebar'), document.querySelector('.titlebar')]) {
  zona.addEventListener('click', (e) => {
    if (e.target.closest('select, input, #btnSettings')) return;
    volverAlTerminal();
  });
}

/* ──────────────────────── Controles de ventana ─────────────────────── */

$('btnMin').addEventListener('click', () => api.win.minimize());
$('btnMax').addEventListener('click', () => api.win.maximize());
$('btnClose').addEventListener('click', () => api.win.close());

/* ────────────────────────────── Arranque ───────────────────────────── */

async function boot() {
  // Lo primero es pintar algo: el banner no depende de nada y hace que la
  // ventana deje de parecer vacia mientras llega la configuracion
  banner([
    '',
    '  \x1b[1;97mG\x1b[0m\x1b[1;38;5;209mCENTER\x1b[0m  \x1b[38;5;240mv1.0\x1b[0m',
    '  \x1b[38;5;245mClaude Code dirige, revisa y toma el relevo.\x1b[0m',
    '  \x1b[38;5;245mLos agentes gratuitos ejecutan.\x1b[0m',
    ''
  ]);
  term.focus();

  // Config y proveedores van en paralelo; en cuanto llega la config ya se
  // puede lanzar Claude, sin esperar al listado de proveedores
  const [cfg, provs] = await Promise.all([api.config.get(), api.providers.list()]);
  state.cfg = cfg;
  state.providers = provs;

  aplicarTema(cfg.theme);
  $('effortSel').value = cfg.effort || '';
  $('modeSel').value = cfg.permissionMode || 'acceptEdits';
  renderModels();
  renderCwd();
  renderStats(state.stats);

  const active = state.providers.filter((p) => p.hasKey);

  if (active.length) {
    term.writeln(
      '  \x1b[38;5;245mEquipo disponible:\x1b[0m \x1b[97m' +
        active.map((p) => p.label).join('\x1b[0m, \x1b[97m') + '\x1b[0m'
    );
  } else {
    term.writeln('  \x1b[38;5;209m!\x1b[0m Ningun agente gratuito configurado todavia.');
    term.writeln(
      '    \x1b[38;5;245mPulsa el engranaje del panel derecho y pega al menos una API key.\x1b[0m'
    );
    term.writeln('    \x1b[38;5;245mRecomendado para empezar: Groq (gratis, sin tarjeta, instantaneo).\x1b[0m');
  }
  term.writeln('');

  setSessionState('busy', 'arrancando claude');
  const ok = await api.session.start();
  if (!ok) setSessionState('err', 'error');

  setTimeout(fit, 300);
  term.focus();
}

boot();
