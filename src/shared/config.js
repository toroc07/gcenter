'use strict';

/**
 * Configuracion compartida entre el proceso principal de Electron y el servidor
 * MCP. Deliberadamente NO depende de electron: el servidor MCP arranca como un
 * proceso hijo de claude.exe y tiene que poder leer lo mismo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function configDir() {
  if (process.env.GCENTER_HOME) return process.env.GCENTER_HOME;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'GCenter');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'GCenter');
  }
  return path.join(os.homedir(), '.config', 'gcenter');
}

const CONFIG_PATH = path.join(configDir(), 'config.json');
const RUNTIME_PATH = path.join(configDir(), 'runtime.json');
const MCP_CONFIG_PATH = path.join(configDir(), 'mcp.json');

const DEFAULTS = {
  // Agentes que el propio usuario ha anadido: { id, name, kind, key, baseUrl }.
  // GCenter no trae ninguno de serie: cada persona usa sus propias cuentas, y
  // las llaves solo viven aqui, en su carpeta de configuracion local.
  agents: [],
  // Rechaza cualquier modelo que cobre por token (o cuya gratuidad no se pueda
  // comprobar) antes de llamar al proveedor. Se aplica a todos los agentes.
  freeOnly: true,
  // Quien dirige la sesion: 'claude' (Claude Code) u 'opencode' (OpenCode).
  // Cada uno usa la cuenta con la que el usuario haya iniciado sesion en el.
  orchestrator: 'claude',
  // Ajustes propios de OpenCode. Los de Claude son model/effort/permissionMode.
  opencode: { model: '', mode: 'build' },
  // Modelos que el catalogo anuncia pero que al usarlos resultan restringidos.
  // Se aprenden solos ("proveedor|modelo") y se recuerdan entre sesiones.
  restrictedModels: [],
  // Modelo de Claude Code cuando es el orquestador
  model: 'opus',
  // Nivel de esfuerzo del modelo: low, medium, high, xhigh, max.
  // Vacio significa no pasar el flag y dejar el que Claude elija por defecto.
  effort: '',
  // Aspecto de la interfaz: 'dark' o 'light'
  theme: 'dark',
  // Directorio donde se ejecuta la sesion (seleccionable desde el sidebar)
  cwd: '',
  recentDirs: [],
  permissionMode: 'acceptEdits',
  // Limite de seguridad para no dejar agentes colgados eternamente
  agentTimeoutMs: 180000,
  // Debe coincidir con el tope que declara la herramienta delegate_parallel,
  // para no descartar tareas en silencio
  maxParallelAgents: 8
};

function ensureDir() {
  fs.mkdirSync(configDir(), { recursive: true });
}

function readJSON(file, fallback) {
  try {
    // Cualquier editor de Windows (o PowerShell con -Encoding utf8) puede dejar
    // un BOM al principio, y JSON.parse revienta con el. Como el fallback de
    // esta funcion son los valores por defecto, un BOM se traducia en "no hay
    // ninguna API key configurada": mejor quitarlo que perder las llaves.
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    return fallback;
  }
}

/**
 * Nombres con los que se crean los agentes al migrar una configuracion de la
 * version 1, que guardaba una llave por proveedor fijo en `keys`.
 */
const NOMBRES_V1 = {
  groq: 'Groq',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  nvidia: 'NVIDIA',
  mistral: 'Mistral'
};

/**
 * Convierte las llaves de la version 1 en agentes. Los ids se conservan
 * ("groq", "gemini"...) para que el historial de valoraciones y los modelos
 * restringidos que ya se habian aprendido sigan valiendo.
 */
function migrarLlavesV1(raw) {
  if (Array.isArray(raw.agents) || !raw.keys || typeof raw.keys !== 'object') return null;

  const agents = [];
  for (const [id, key] of Object.entries(raw.keys)) {
    if (!NOMBRES_V1[id] || !key || !String(key).trim()) continue;
    agents.push({ id, name: NOMBRES_V1[id], kind: id, key: String(key).trim() });
  }

  const next = Object.assign({}, raw, { agents });
  delete next.keys;
  return next;
}

function load() {
  let raw = readJSON(CONFIG_PATH, {});

  const migrada = migrarLlavesV1(raw);
  if (migrada) {
    raw = migrada;
    try {
      ensureDir();
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), 'utf8');
    } catch (e) {
      /* si no se puede guardar, la migracion se repite en el proximo arranque */
    }
  }

  const cfg = Object.assign({}, DEFAULTS, raw);
  cfg.agents = Array.isArray(raw.agents) ? raw.agents : [];
  cfg.opencode = Object.assign({}, DEFAULTS.opencode, raw.opencode || {});
  delete cfg.keys;
  if (!cfg.cwd) cfg.cwd = os.homedir();
  return cfg;
}

function save(patch) {
  ensureDir();
  const actual = load();
  const next = Object.assign({}, actual, patch);
  if (patch && patch.opencode) next.opencode = Object.assign({}, actual.opencode, patch.opencode);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Configuracion guardada de un agente, o null si no existe. */
function agentConfig(id) {
  return load().agents.find((a) => a.id === id) || null;
}

/**
 * Modo de permisos del orquestador activo, para saber si los agentes pueden
 * escribir en disco por su cuenta o si el resultado tiene que pasar antes por
 * las manos del orquestador.
 */
function escrituraSupervisada(cfg) {
  const c = cfg || load();
  if (c.orchestrator === 'opencode') return (c.opencode && c.opencode.mode) === 'plan';
  return ['plan', 'manual', 'dontAsk'].includes(c.permissionMode || 'acceptEdits');
}

/** Datos volatiles de la sesion viva (puerto del bus + token). */
function loadRuntime() {
  return readJSON(RUNTIME_PATH, null);
}

function saveRuntime(data) {
  ensureDir();
  fs.writeFileSync(RUNTIME_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function clearRuntime() {
  try {
    fs.unlinkSync(RUNTIME_PATH);
  } catch (e) {
    /* ya no estaba */
  }
}

module.exports = {
  DEFAULTS,
  configDir,
  CONFIG_PATH,
  RUNTIME_PATH,
  MCP_CONFIG_PATH,
  load,
  save,
  agentConfig,
  escrituraSupervisada,
  migrarLlavesV1,
  loadRuntime,
  saveRuntime,
  clearRuntime
};
