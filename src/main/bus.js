'use strict';

/**
 * Bus de telemetria: servidor WebSocket local al que se conecta el servidor MCP
 * para contarnos que agentes arrancan, progresan o terminan.
 *
 * Escucha solo en 127.0.0.1 y exige un token aleatorio que se regenera en cada
 * arranque, para que nada mas de la maquina pueda inyectar eventos falsos.
 */

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const config = require('../shared/config');

let wss = null;
let token = null;
let port = null;

/**
 * @param {(event: object) => void} onEvent  callback con cada evento recibido
 * @returns {Promise<{port:number, token:string}>}
 */
function start(onEvent) {
  return new Promise((resolve, reject) => {
    token = crypto.randomBytes(24).toString('hex');
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    wss.on('listening', () => {
      port = wss.address().port;
      // El servidor MCP lo lee de aqui para saber a donde conectarse
      config.saveRuntime({ port, token, pid: process.pid, startedAt: Date.now() });
      resolve({ port, token });
    });

    wss.on('error', reject);

    wss.on('connection', (socket, req) => {
      let provided = '';
      try {
        provided = new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || '';
      } catch (e) {
        /* url rara: se queda vacio y se rechaza */
      }

      // Comparacion en tiempo constante para no filtrar el token por timing
      const a = Buffer.from(provided);
      const b = Buffer.from(token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        socket.close(1008, 'token invalido');
        return;
      }

      socket.on('message', (data) => {
        let event;
        try {
          event = JSON.parse(data.toString());
        } catch (e) {
          return;
        }
        onEvent(event);
      });
    });
  });
}

function stop() {
  config.clearRuntime();
  if (wss) {
    try {
      wss.close();
    } catch (e) {
      /* ya cerrado */
    }
  }
  wss = null;
}

function info() {
  return { port, token };
}

module.exports = { start, stop, info };
