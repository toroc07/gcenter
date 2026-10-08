'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Unica superficie que el renderer ve del proceso principal. Nada de `require`
 * suelto en la interfaz: todo pasa por aqui.
 */
const api = {
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close')
  },

  session: {
    start: () => ipcRenderer.invoke('session:start'),
    stop: () => ipcRenderer.invoke('session:stop'),
    restart: () => ipcRenderer.invoke('session:restart'),
    write: (data) => ipcRenderer.invoke('session:write', data),
    resize: (cols, rows) => ipcRenderer.invoke('session:resize', { cols, rows }),
    status: () => ipcRenderer.invoke('session:status'),
    setModel: (model) => ipcRenderer.invoke('session:setModel', model),
    setEffort: (effort) => ipcRenderer.invoke('session:setEffort', effort),
    setPermissionMode: (mode) => ipcRenderer.invoke('session:setPermissionMode', mode)
  },

  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
    setKey: (provider, value) => ipcRenderer.invoke('config:setKey', { provider, value })
  },

  dir: {
    choose: () => ipcRenderer.invoke('dir:choose'),
    set: (dir) => ipcRenderer.invoke('dir:set', dir)
  },

  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    check: (id) => ipcRenderer.invoke('providers:check', id)
  },

  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  /** Suscripcion a los eventos que empuja el proceso principal. */
  on: (channel, handler) => {
    const allowed = [
      'session:data',
      'session:exit',
      'session:started',
      'session:error',
      'agents:event'
    ];
    if (!allowed.includes(channel)) return () => {};

    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
};

contextBridge.exposeInMainWorld('gcenter', api);
