'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, screen } = require('electron');

const config = require('../shared/config');
const providers = require('../mcp/providers');
const bus = require('./bus');
const { ClaudeSession } = require('./session');
const { locate } = require('./claude-locator');

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

function boot() {
  nativeTheme.themeSource = 'dark';

  // La ventana primero: es lo unico que el usuario esta esperando ver. El bus
  // tarda unos milisegundos, pero encadenarlo aqui retrasaba el primer pintado.
  createWindow();

  sesionLista = bus.start((event) => send('agents:event', event)).then(({ port, token }) => {
    session = new ClaudeSession({ emit: send });
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
 * IPC: sesion de Claude
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
  running: Boolean(session && session.running),
  claudePath: locate(config.load().claudePath)
}));

ipcMain.handle('session:setModel', async (_e, model) => {
  const s = await sesionLista;
  const hot = s.switchModel(model);
  return { hot, running: s.running };
});

ipcMain.handle('session:setEffort', async (_e, effort) => {
  const s = await sesionLista;
  const hot = s.switchEffort(effort);
  return { hot, running: s.running };
});

ipcMain.handle('session:setPermissionMode', async (_e, mode) => {
  const s = await sesionLista;
  return s.setPermissionMode(mode);
});

/* ------------------------------------------------------------------ *
 * IPC: configuracion y directorio de trabajo
 * ------------------------------------------------------------------ */

ipcMain.handle('config:get', () => {
  const cfg = config.load();
  // Nunca mandamos las llaves completas al renderer: solo si estan puestas
  const masked = {};
  for (const [id, value] of Object.entries(cfg.keys)) {
    masked[id] = value ? value.slice(0, 4) + '...' + value.slice(-4) : '';
  }
  return Object.assign({}, cfg, { keys: masked });
});

ipcMain.handle('config:set', (_e, patch) => {
  config.save(patch);
  return true;
});

ipcMain.handle('config:setKey', (_e, { provider, value }) => {
  const cfg = config.load();
  const keys = Object.assign({}, cfg.keys);
  keys[provider] = value;
  config.save({ keys });
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
 * IPC: proveedores de agentes
 * ------------------------------------------------------------------ */

ipcMain.handle('providers:list', () => {
  const cfg = config.load();
  return providers.listProviders().map((p) => {
    const key = config.apiKeyFor(p.id, p.keyName);
    return Object.assign({}, p, {
      hasKey: Boolean(key),
      // Marcamos si la llave viene del entorno para que el usuario no se
      // extrane de ver el proveedor activo con el campo de Ajustes vacio
      fromEnv: Boolean(process.env[p.keyName]) && !cfg.keys[p.id]
    });
  });
});

ipcMain.handle('providers:check', async (_e, providerId) => {
  const list = providers.listProviders();
  const meta = list.find((p) => p.id === providerId);
  if (!meta) return { ok: false, error: 'proveedor desconocido' };

  const key = config.apiKeyFor(providerId, meta.keyName);
  if (!key) return { ok: false, error: 'sin API key' };

  // `force` porque el boton "Probar" debe comprobar de verdad, no responder
  // desde la cache de catalogos
  const res = await providers.fetchModels(providerId, key, { timeoutMs: 20000, force: true });
  return { ok: res.ok, error: res.error, models: res.models, count: res.models.length };
});
