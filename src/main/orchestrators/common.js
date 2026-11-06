'use strict';

/**
 * Piezas que comparten todos los orquestadores: donde estan los recursos, el
 * servidor MCP de GCenter y el entorno limpio con el que se lanzan.
 */

const path = require('path');
const config = require('../../shared/config');

/**
 * Dentro de un paquete los recursos viven en app.asar. Electron sabe leer de
 * ahi, asi que sus propios ficheros se resuelven tal cual.
 */
function resolveResource(rel) {
  return path.join(__dirname, '..', '..', rel);
}

/**
 * Ruta para ficheros que va a abrir un proceso ajeno a Electron. Ni claude ni
 * opencode entienden el formato asar, asi que estos recursos se declaran en
 * `asarUnpack` y se sirven desde la carpeta desempaquetada de al lado.
 */
function resolveExternalResource(rel) {
  return resolveResource(rel).replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
}

/** Prompt de orquestador que se inyecta en cualquiera de los dos. */
function promptPath() {
  return resolveExternalResource(path.join('..', 'prompts', 'orchestrator.md'));
}

/**
 * Como arrancar el servidor MCP de GCenter. Cada orquestador lo declara con su
 * propio formato de configuracion, pero el proceso es el mismo.
 */
function mcpServer({ cwd, busPort, busToken, orchestratorLabel }) {
  return {
    command: process.execPath,
    args: [resolveResource(path.join('mcp', 'server.js'))],
    env: {
      // Hace que el propio Electron actue como runtime de Node, asi el paquete
      // no depende de que el usuario tenga Node instalado
      ELECTRON_RUN_AS_NODE: '1',
      // Anclamos el directorio de configuracion en vez de dejar que el
      // servidor MCP lo deduzca: asi lee los mismos agentes que la interfaz
      // aunque herede un entorno distinto del nuestro
      GCENTER_HOME: config.configDir(),
      // Los agentes leen y escriben archivos del proyecto: tienen que saber
      // cual es, y quedarse dentro de el
      GCENTER_CWD: cwd,
      GCENTER_BUS_PORT: String(busPort),
      GCENTER_BUS_TOKEN: busToken,
      // Para que los avisos digan a quien le toca el trabajo
      GCENTER_ORCHESTRATOR: orchestratorLabel
    }
  };
}

/**
 * Variables que describen una sesion PADRE de un orquestador.
 *
 * Si GCenter se abre desde un terminal que ya es una sesion de Claude Code (el
 * integrado de VS Code con la extension, por ejemplo) o de OpenCode, hereda
 * estas variables y se las pasaria a su propio orquestador, que entonces se
 * cree una subsesion: deja de guardar la conversacion (y con ello deja de
 * funcionar --continue), se conecta al canal de mensajeria de la otra sesion o
 * adopta ajustes que el usuario no eligio. Se quitan solo las que marcan
 * estado de sesion; la configuracion del usuario se respeta.
 */
const HERENCIA_DE_SESION = [
  /^CLAUDECODE$/,
  /^CLAUDE_PID$/,
  /^CLAUDE_EFFORT$/,
  /^CLAUDE_AGENT_SDK_/,
  /^CLAUDE_CODE_(CHILD_SESSION|SESSION_|MESSAGING_|ENTRYPOINT|EXECPATH|SSE_PORT|EMIT_STARTUP_TIMING|ENABLE_TASKS|ENABLE_SDK_|QUESTION_PREVIEW)/,
  /^MCP_CONNECTION_NONBLOCKING$/,
  /^OPENCODE_(CONFIG|CONFIG_CONTENT|CONFIG_DIR|SESSION_ID|SERVER_PASSWORD|PASSWORD|TUI_CHANNEL|CLIENT)$/
];

/** Entorno heredado sin restos de Electron ni de otra sesion de orquestador. */
function entornoLimpio(extra) {
  const env = Object.assign({}, process.env);

  // Que el orquestador no herede el modo "ejecutar como node" de Electron
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) {
    if (HERENCIA_DE_SESION.some((re) => re.test(k))) delete env[k];
  }

  // Lo nuestro va despues de limpiar: la configuracion que inyectamos a
  // OpenCode usa justo nombres de la lista anterior
  return Object.assign(env, { FORCE_COLOR: '3', TERM: 'xterm-256color' }, extra || {});
}

module.exports = {
  resolveResource,
  resolveExternalResource,
  promptPath,
  mcpServer,
  entornoLimpio,
  HERENCIA_DE_SESION
};
