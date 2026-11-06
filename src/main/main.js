'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme, screen } = require('electron');

const config = require('../shared/config');
const providers = require('../mcp/providers');
const bus = require('./bus');
const { Session, orquestador, binDe, instalados } = require('./session');

let win = null;
let session = null;

const isDev = process.argv.includes('--dev');

// Chromium deja de componer las ventanas que considera tapadas. En una app de
// terminal eso significa perder el pintado mientras trabajas en otra ventana.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  // En pantallas pequenas una ventana fija de 1360 se sale del escritorio y
  // deja el sidebar fuera de la vista, asi que la ajustamos al area util
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: Math.min(1360, sw - 40),
    height: Math.min(880, sh - 40),
    center: true,
    minWidth: 860,
    minHeight: 520,
    // Se muestra ya, sin esperar al primer pintado. Como el fondo coincide con
    // el del tema, aparece como un rectangulo oscuro que se va rellenando, en
    // vez de dejar al usuario varios segundos sin ninguna senal de vida.
    show: true,
    // Coincide con el fondo del tema guardado, para que el rectangulo que
    // aparece antes del primer pintado no sea de otro color
    backgroundColor: config.load().theme === 'light' ? '#faf9f7' : '#141414',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Un terminal sigue recibiendo salida aunque la ventana no este delante:
      // si Chromium lo ralentiza, al volver aparece un salto de contenido en
      // lugar del flujo continuo
      backgroundThrottling: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // Un error en el renderer deja la ventana en negro sin decir nada. Sacarlo
  // por stderr del proceso principal hace que se pueda diagnosticar sin tener
  // que abrir las herramientas de desarrollo.
  // Electron cambio la firma de este evento: antes llegaban argumentos sueltos
  // y ahora un objeto. Aceptamos las dos formas para no quedarnos ciegos segun
  // la version.
  win.webContents.on('console-message', (ev, nivel, texto, linea, origen) => {
    const detalle = ev && typeof ev === 'object' && 'message' in ev
      ? ev
      : { level: nivel, message: texto, lineNumber: linea, sourceId: origen };

    const grave = detalle.level === 'error' || detalle.level === 'warning' || detalle.level >= 2;
    if (!grave) return;
    console.error('[renderer] ' + detalle.message +
      '  (' + detalle.sourceId + ':' + detalle.lineNumber + ')');
  });

  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('[renderer] el proceso murio: ' + JSON.stringify(d));
  });

  // Los enlaces del terminal se abren en el navegador, no dentro de la app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });
}

/**
 * Se resuelve cuando la sesion esta lista para arrancar. El renderer puede
 * pedir `session:start` antes de que el bus haya terminado de levantarse, y
 * esperar aqui es mejor que retrasar la ventana por si acaso.
 */
let sesionLista = null;

/**
 * En macOS los atajos de edicion (Cmd+C, Cmd+V, Cmd+Q) los da el menu de la
 * aplicacion: sin el, no funcionan ni en los campos de texto. En Windows y
 * Linux no se toca nada.
 */
function instalarMenu() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
}

function boot() {
  nativeTheme.themeSource = 'dark';
  instalarMenu();

  // La ventana primero: es lo unico que el usuario esta esperando ver. El bus
  // tarda unos milisegundos, pero encadenarlo aqui retrasaba el primer pintado.
  createWindow();

  sesionLista = bus.start((event) => send('agents:event', event)).then(({ port, token }) => {
    session = new Session({ emit: send });
    session.setBus(port, token);
    return session;
  });

  return sesionLista;
}

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  if (session) session.stop();
  bus.stop();
  app.quit();
});

app.on('before-quit', () => {
  if (session) session.stop();
  bus.stop();
});

/* ------------------------------------------------------------------ *
 * IPC: ventana
 * ------------------------------------------------------------------ */

ipcMain.handle('win:minimize', () => win && win.minimize());
ipcMain.handle('win:maximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('win:close', () => win && win.close());
ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));

/* ------------------------------------------------------------------ *
 * IPC: sesion del orquestador
 * ------------------------------------------------------------------ */

ipcMain.handle('session:start', async () => (await sesionLista).start());
ipcMain.handle('session:stop', () => session && session.stop());
ipcMain.handle('session:restart', async () => {
  const s = await sesionLista;
  s.stop();
  return s.start();
});
ipcMain.handle('session:write', (_e, data) => session && session.write(data));
ipcMain.handle('session:resize', (_e, { cols, rows }) => session && session.resize(cols, rows));
ipcMain.handle('session:status', () => ({
  running: Boolean(session && session.running)
}));

ipcMain.handle('session:setModel', async (_e, model) => (await sesionLista).cambiarAjuste('model', model));
ipcMain.handle('session:setEffort', async (_e, effort) => (await sesionLista).cambiarAjuste('effort', effort));
ipcMain.handle('session:setMode', async (_e, mode) => (await sesionLista).cambiarAjuste('mode', mode));

/* ------------------------------------------------------------------ *
 * IPC: eleccion de orquestador
 * ------------------------------------------------------------------ */

/**
 * Todo lo que la interfaz necesita para pintar el panel del orquestador:
 * cuales estan instalados, el activo, sus modelos, modos y esfuerzos.
 */
ipcMain.handle('orchestrator:info', async () => {
  const cfg = config.load();
  const orq = orquestador(cfg.orchestrator);
  const bin = binDe(orq, cfg);
  return {
    active: orq.id,
    label: orq.label,
    orchestrators: instalados(cfg),
    models: await orq.modelos(bin, cfg),
    modes: orq.modos,
    efforts: orq.esfuerzos,
    current: orq.estado(cfg),
    freeOnly: cfg.freeOnly !== false
  };
});

/** Cambia de orquestador. Empieza una conversacion nueva: no hay forma de
 *  continuar en OpenCode una conversacion de Claude Code, ni al reves. */
ipcMain.handle('orchestrator:set', async (_e, id) => {
  if (!['claude', 'opencode'].includes(id)) return { ok: false };
  config.save({ orchestrator: id });
  const s = await sesionLista;
  s.stop();
  return { ok: s.start() };
});

/* ------------------------------------------------------------------ *
 * IPC: configuracion y directorio de trabajo
 * ------------------------------------------------------------------ */

/** Nunca mandamos las llaves completas al renderer: solo un trozo para reconocerlas. */
function enmascarar(key) {
  const k = String(key || '');
  if (!k) return '';
  return k.length > 12 ? k.slice(0, 4) + '...' + k.slice(-4) : '...' + k.slice(-2);
}

ipcMain.handle('config:get', () => {
  const cfg = config.load();
  return Object.assign({}, cfg, {
    agents: cfg.agents.map((a) => Object.assign({}, a, { key: enmascarar(a.key) }))
  });
});

// Solo ajustes de interfaz: los agentes y el orquestador tienen su propio IPC
const AJUSTES_LIBRES = ['freeOnly', 'theme'];
ipcMain.handle('config:set', (_e, patch) => {
  const limpio = {};
  for (const k of AJUSTES_LIBRES) if (patch && k in patch) limpio[k] = patch[k];
  config.save(limpio);
  return true;
});

ipcMain.handle('dir:choose', async () => {
  const cfg = config.load();
  const res = await dialog.showOpenDialog(win, {
    title: 'Elige el directorio de trabajo',
    defaultPath: cfg.cwd,
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('dir:set', (_e, dir) => {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'El directorio no existe' };

  const cfg = config.load();
  const recent = [dir].concat((cfg.recentDirs || []).filter((d) => d !== dir)).slice(0, 8);
  config.save({ cwd: dir, recentDirs: recent });

  return { ok: true, cwd: dir, recentDirs: recent };
});

/* ------------------------------------------------------------------ *
 * IPC: agentes del usuario
 * ------------------------------------------------------------------ */

/** Lo que la interfaz ve de un agente: nunca la llave entera. */
function vistaAgente(a) {
  return {
    id: a.id,
    name: a.label,
    kind: a.kind,
    providerLabel: a.providerLabel,
    color: a.color,
    baseUrl: a.custom ? a.baseUrl : '',
    signupUrl: a.signupUrl,
    key: enmascarar(a.key),
    custom: a.custom
  };
}

/**
 * Prueba un agente contra su proveedor: si la llave vale, cuantos modelos hay
 * y cuantos son gratuitos, y si su gratuidad se puede comprobar.
 */
async function probar(agent) {
  const cfg = config.load();
  const res = await providers.fetchModels(agent, { timeoutMs: 20000, force: true });
  return {
    ok: res.ok,
    error: res.error,
    total: (res.raw || []).length,
    freeCount: res.freeCount || 0,
    usable: res.models.length,
    verificable: res.verificable !== false,
    bloqueado: Boolean(res.bloqueado),
    freeOnly: cfg.freeOnly !== false
  };
}

ipcMain.handle('agents:list', () => providers.listAgents().map(vistaAgente));

ipcMain.handle('agents:templates', () => providers.listPlantillas());

/** Mientras el usuario escribe: que proveedor es y si hara falta la URL. */
ipcMain.handle('agents:detect', (_e, { name, key }) => {
  const kind = providers.detectar(name, key);
  const p = kind ? providers.PLANTILLAS[kind] : null;
  return p ? { kind, label: p.label, signupUrl: p.signupUrl } : { kind: null };
});

/**
 * Anade un agente. Primero lo prueba: un agente que ni siquiera responde no
 * se guarda, para que el usuario se entere en el momento y no a mitad de un
 * proyecto.
 */
ipcMain.handle('agents:add', async (_e, { name, key, baseUrl }) => {
  const nombre = String(name || '').trim();
  const llave = String(key || '').trim();
  if (!nombre) return { ok: false, error: 'Falta el nombre del agente.' };
  if (!llave) return { ok: false, error: 'Falta la API key.' };

  const kind = providers.detectar(nombre, llave);
  const url = providers.normalizarUrl(baseUrl);
  if (!kind && !/^https?:\/\//i.test(url)) {
    return { ok: false, needUrl: true, error: 'No reconozco este proveedor: indica su URL base (compatible con OpenAI).' };
  }

  const cfg = config.load();
  const nuevo = {
    id: providers.idLibre(nombre, cfg.agents.map((a) => a.id)),
    name: nombre,
    kind: kind || 'custom',
    key: llave
  };
  if (!kind) nuevo.baseUrl = url;

  const prueba = await probar(providers.resolverAgente(nuevo));
  if (!prueba.ok) return Object.assign({ ok: false }, prueba, { error: 'No responde: ' + prueba.error });

  config.save({ agents: cfg.agents.concat([nuevo]) });
  return Object.assign({}, prueba, { ok: true, agent: vistaAgente(providers.resolverAgente(nuevo)) });
});

ipcMain.handle('agents:remove', (_e, id) => {
  const cfg = config.load();
  config.save({ agents: cfg.agents.filter((a) => a.id !== id) });
  return true;
});

ipcMain.handle('agents:check', async (_e, id) => {
  let agent;
  try {
    agent = providers.getAgent(id);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return probar(agent);
});
