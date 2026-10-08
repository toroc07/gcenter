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
  return path.join(os.homedir(), '.config', 'gcenter');
}

const CONFIG_PATH = path.join(configDir(), 'config.json');
const RUNTIME_PATH = path.join(configDir(), 'runtime.json');
const MCP_CONFIG_PATH = path.join(configDir(), 'mcp.json');

const DEFAULTS = {
  // Claves de cada proveedor gratuito. Vacio = proveedor apagado.
  keys: { groq: '', gemini: '', openrouter: '', nvidia: '', mistral: '' },
  // Rechaza cualquier modelo que cobre por token antes de llamar al proveedor.
  // Desactivarlo solo tiene sentido si has anadido saldo a proposito.
  freeOnly: true,
  // Modelos que el catalogo anuncia pero que al usarlos resultan restringidos.
  // Se aprenden solos ("proveedor|modelo") y se recuerdan entre sesiones.
  restrictedModels: [],
  // Modelo de Claude Code que hace de jefe
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

function load() {
  const raw = readJSON(CONFIG_PATH, {});
  const cfg = Object.assign({}, DEFAULTS, raw);
  cfg.keys = Object.assign({}, DEFAULTS.keys, raw.keys || {});
  if (!cfg.cwd) cfg.cwd = os.homedir();
  return cfg;
}

function save(patch) {
  ensureDir();
  const next = Object.assign({}, load(), patch);
  if (patch && patch.keys) next.keys = Object.assign({}, load().keys, patch.keys);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * Resuelve la API key de un proveedor. La variable de entorno gana sobre el
 * fichero, para que quien ya tenga sus llaves exportadas no tenga que repetirlas.
 */
function apiKeyFor(providerId, keyName) {
  const fromEnv = keyName && process.env[keyName];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const cfg = load();
  const fromFile = cfg.keys[providerId];
  return fromFile && fromFile.trim() ? fromFile.trim() : '';
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
  apiKeyFor,
  loadRuntime,
  saveRuntime,
  clearRuntime
};
