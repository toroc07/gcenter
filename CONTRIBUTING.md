# Contribuir a GCenter

Gracias por el interés. Esta guía explica cómo ejecutar GCenter desde el código
fuente, cómo está organizado y cómo probar los cambios.

## Ejecutar desde el código fuente

Necesitas Node.js 18 o superior y [Claude Code](https://claude.com/claude-code)
instalado.

```bash
git clone https://github.com/toroc07/gcenter.git
cd gcenter
npm install
npm start          # o npm run dev para abrir también las herramientas de desarrollo
```

Si `npm install` no descarga el binario de Electron, fuérzalo con
`node node_modules/electron/install.js`.

## Generar los paquetes

Cada sistema compila los suyos:

```bash
npm run dist          # en Windows: instalador y portable
npm run dist:linux    # en Linux: AppImage y .deb
```

Los paquetes **solo se pueden generar en su propio sistema**: npm instala
únicamente el binario de terminal (`node-pty`) de la plataforma en la que se
ejecuta, así que un paquete de Linux construido en Windows llevaría el binario
de Windows y no abriría el terminal.

## Estructura del proyecto

```
src/
├── main/            proceso principal de Electron
│   ├── main.js          ventana, IPC y ciclo de vida
│   ├── session.js       sesión de Claude Code en un pseudo-terminal
│   ├── bus.js           canal local de telemetría de los agentes
│   └── claude-locator.js
├── mcp/             servidor MCP que ejecutan los agentes
│   ├── server.js        herramientas expuestas a Claude
│   ├── providers.js     catálogo de proveedores y política de gratuidad
│   ├── capabilities.js  reparto por especialidad
│   ├── workspace.js     lectura y escritura confinada al proyecto
│   ├── health.js        salud del equipo
│   ├── quality.js       control de calidad de las respuestas
│   └── feedback.js      valoraciones persistentes
├── renderer/        interfaz (xterm.js y panel lateral)
└── shared/          configuración común
prompts/             prompt que convierte a Claude en orquestador
scripts/             utilidades de build
test/                pruebas
tools/               herramientas de diagnóstico
```

## Pruebas

```bash
npm test             # prueba de humo del servidor MCP (sin llaves ni tokens)
```

Es la que ejecuta el CI en cada push. El resto se lanzan a mano según lo que
toques. Algunas usan modelos gratuitos reales y consumen parte de tu cuota:

| Comando | Qué comprueba | ¿Consume cuota? |
|---|---|---|
| `npm test` | Que el servidor MCP arranca y expone sus herramientas | No |
| `npm run test:guard` | Que los modelos de pago se rechazan | Una llamada gratuita de control |
| `npm run test:restart` | Que reiniciar la sesión no deja procesos huérfanos | No |
| `node test/pty.test.js` | Que el pseudo-terminal nativo funciona | No |
| `node test/modes.test.js` | Que cada modo de permisos arranca | No |
| `npm run test:delegation` | Reparto de una calculadora en tres archivos y ahorro de tokens | Sí, modelos gratuitos |
| `node test/supervision.test.js` | Reparto por especialidad, reencaminado y salud | Sí, modelos gratuitos |
| `node test/all-providers.test.js` | Delegación simultánea a todos los proveedores | Sí, modelos gratuitos |

## Herramientas de diagnóstico

| Comando | Qué hace | ¿Consume cuota? |
|---|---|---|
| `npm run audit` | Qué proveedores están activos y cuántos modelos gratuitos ofrecen | No |
| `npm run probe` | Qué proveedores alcanza tu red, sin llaves | No |
| `node tools/probe-openrouter.js` | Detecta modelos gratuitos de OpenRouter restringidos | Sí, una petición por modelo |
| `node tools/explore-catalogs.js [familia]` | Explora catálogos públicos por familia de modelo | No |
| `npm run demo` | Agentes simulados para revisar el panel lateral | No |

## Antes de abrir un pull request

- `npm test` en verde, y las pruebas relacionadas con lo que hayas cambiado.
- Si tocas la política de un proveedor, ejecuta `npm run test:guard`: ningún
  modelo de pago debe colarse.
- Ningún dato personal: ni API keys, ni rutas de tu equipo, ni capturas reales.
  Las llaves viven fuera del proyecto y nunca deben acabar en el repositorio.
- Comentarios que expliquen el porqué, no el qué, igual que el resto del código.

Para informar de una vulnerabilidad, consulta [SECURITY.md](SECURITY.md) en
lugar de abrir un issue público.
