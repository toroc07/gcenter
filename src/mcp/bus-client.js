'use strict';

/**
 * Canal de telemetria hacia la interfaz de GCenter.
 *
 * El servidor MCP vive como proceso hijo de claude.exe, asi que no comparte
 * memoria con la ventana de Electron. Para que el sidebar pueda pintar los
 * agentes en vivo, le mandamos eventos por un WebSocket local.
 *
 * Es deliberadamente best-effort: si la app no esta abierta, el servidor MCP
 * sigue funcionando perfectamente, simplemente nadie pinta los eventos.
 */

const WebSocket = require('ws');
const { loadRuntime } = require('../shared/config');

let socket = null;
let connecting = false;
const pending = [];
const MAX_PENDING = 200;

function log(msg) {
  // stdout esta reservado para el protocolo MCP: todo lo nuestro va a stderr
  process.stderr.write('[gcenter-bus] ' + msg + '\n');
}

/**
 * El puerto y el token llegan por variables de entorno cuando nos lanza la app
 * (es la via fiable). El fichero runtime.json es el plan B para cuando el
 * servidor MCP se arranca a mano desde fuera de GCenter.
 */
function busTarget() {
  if (process.env.GCENTER_BUS_PORT) {
    return { port: Number(process.env.GCENTER_BUS_PORT), token: process.env.GCENTER_BUS_TOKEN || '' };
  }
  return loadRuntime();
}

function connect() {
  if (connecting || (socket && socket.readyState === WebSocket.OPEN)) return;

  const runtime = busTarget();
  if (!runtime || !runtime.port) return; // la app no esta corriendo

  connecting = true;
  const url = 'ws://127.0.0.1:' + runtime.port + '/bus?token=' + encodeURIComponent(runtime.token || '');

  try {
    socket = new WebSocket(url);
  } catch (err) {
    connecting = false;
    return;
  }

  socket.on('open', () => {
    connecting = false;
    send({ type: 'mcp.hello', pid: process.pid });
    while (pending.length) socket.send(JSON.stringify(pending.shift()));
  });

  socket.on('error', () => {
    connecting = false;
  });

  socket.on('close', () => {
    connecting = false;
    socket = null;
  });
}

function send(event) {
  const payload = Object.assign({ ts: Date.now() }, event);

  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(payload));
      return;
    } catch (err) {
      /* cae al buffer */
    }
  }

  if (pending.length >= MAX_PENDING) pending.shift();
  pending.push(payload);
  connect();
}

function close() {
  if (socket) {
    try {
      socket.close();
    } catch (e) {
      /* da igual */
    }
  }
  socket = null;
}

module.exports = { send, connect, close, log };
