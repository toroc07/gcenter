'use strict';

/**
 * Genera docs/screenshot.png para el README.
 *
 * Carga la interfaz REAL de GCenter con un preload de demostracion
 * (tools/screenshot-preload.js) en lugar del de verdad, asi la imagen muestra
 * la app tal cual es pero sin ninguna ruta, sesion ni llave del usuario.
 *
 *   npx electron tools/render-screenshot.js
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SALIDA = path.join(__dirname, '..', 'docs', 'screenshot.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 1000,
    show: false,
    frame: false,
    backgroundColor: '#141414',
    webPreferences: {
      preload: path.join(__dirname, 'screenshot-preload.js'),
      contextIsolation: true,
      sandbox: false,
      offscreen: true
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  // Margen para que xterm mida la ventana, se reproduzcan los eventos y se
  // despliegue el grupo de agentes
  await new Promise((r) => setTimeout(r, 2500));

  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(SALIDA), { recursive: true });
  fs.writeFileSync(SALIDA, img.toPNG());
  console.log('captura guardada en ' + SALIDA + ' (' + img.getSize().width + 'x' + img.getSize().height + ')');

  win.destroy();
  app.quit();
});
