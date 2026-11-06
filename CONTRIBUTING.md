# Contribuir a GCenter

Gracias por el interés. Esta guía explica cómo ejecutar GCenter desde el código
fuente, cómo está organizado y cómo probar los cambios.

## Ejecutar desde el código fuente

Necesitas Node.js 18 o superior y al menos un orquestador instalado, con tu
sesion iniciada: [Claude Code](https://claude.com/claude-code) u
[OpenCode](https://opencode.ai).

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
npm run dist:mac      # en macOS (Apple Silicon): .dmg con firma ad hoc
```

Los iconos se generan con `npm run icon`, que escribe `assets/icon.ico`,
`assets/icon.png` y `assets/icon.icns`.

Los paquetes **solo se pueden generar en su propio sistema**: npm instala
únicamente el binario de terminal (`node-pty`) de la plataforma en la que se
ejecuta, así que un paquete de Linux construido en Windows llevaría el binario
de Windows y no abriría el terminal.

## Estructura del proyecto

```
src/
├── main/            proceso principal de Electron
│   ├── main.js          ventana, IPC y ciclo de vida
│   ├── session.js       sesión del orquestador en un pseudo-terminal
│   ├── locator.js       busca los ejecutables de claude y opencode
│   ├── bus.js           canal local de telemetría de los agentes
│   └── orchestrators/   lo propio de cada orquestador
│       ├── common.js        servidor MCP compartido y entorno limpio
│       ├── claude.js        argumentos, modelos, modos y esfuerzo de Claude Code
│       └── opencode.js      configuración inyectada, modelos y modos de OpenCode
├── mcp/             servidor MCP que ejecutan los agentes
│   ├── server.js        herramientas expuestas al orquestador
│   ├── providers.js     agentes del usuario, plantillas de proveedores y gratuidad
│   ├── capabilities.js  reparto por especialidad
│   ├── workspace.js     lectura y escritura confinada al proyecto
│   ├── health.js        salud del equipo
│   ├── quality.js       control de calidad de las respuestas
│   └── feedback.js      valoraciones persistentes
├── renderer/        interfaz (xterm.js y panel lateral)
└── shared/          configuración común
prompts/             prompt que convierte al orquestador en jefe de proyecto
scripts/             utilidades de build
test/                pruebas
tools/               herramientas de diagnóstico
```

## Pruebas

```bash
npm test             # servidor MCP y agentes (sin llaves, sin red, sin tokens)
```

Es la que ejecuta el CI en cada push. El resto se lanzan a mano según lo que
toques. Algunas usan modelos gratuitos reales y consumen parte de tu cuota:

| Comando | Qué comprueba | ¿Consume cuota? |
|---|---|---|
| `npm test` | Que el servidor MCP arranca, y la detección, la migración, el filtro de gratuidad y el reparto con agentes propios | No |
| `npm run test:guard` | Que los modelos de pago se rechazan (con agentes de llaves falsas) | No |
| `npm run test:restart` | Que reiniciar la sesión no deja procesos huérfanos. Con `ORQUESTADOR=opencode` prueba OpenCode | No |
| `node test/pty.test.js` | Que el pseudo-terminal nativo funciona | No |
| `node test/modes.test.js` | Que cada modo de permisos arranca | No |
| `npm run test:delegation` | Reparto de una calculadora en tres archivos y ahorro de tokens | Sí, modelos gratuitos |
| `node test/supervision.test.js` | Reparto por especialidad, reencaminado y salud | Sí, modelos gratuitos |
| `node test/all-providers.test.js` | Delegación simultánea a todos tus agentes | Sí, modelos gratuitos |

## Herramientas de diagnóstico

| Comando | Qué hace | ¿Consume cuota? |
|---|---|---|
| `npm run audit` | Qué agentes tienes y cuántos modelos gratuitos ofrecen | No |
| `npm run probe` | Qué proveedores alcanza tu red, sin llaves | No |
| `node tools/probe-openrouter.js` | Detecta modelos gratuitos de OpenRouter restringidos | Sí, una petición por modelo |
| `node tools/explore-catalogs.js [familia]` | Explora catálogos públicos por familia de modelo | No |
| `npm run demo` | Agentes simulados para revisar el panel lateral | No |

## Antes de abrir un pull request

- `npm test` en verde, y las pruebas relacionadas con lo que hayas cambiado.
- Si tocas la política de un proveedor, ejecuta `npm run test:guard`: ningún
  modelo de pago debe colarse. Una plantilla nueva solo se añade con su
  facturación verificada: que pasa cuando se agota la cuota y si admite tarjeta.
- Ningún dato personal ni de tus cuentas: ni API keys, ni rutas de tu equipo,
  ni listas de modelos sacadas de tu configuración, ni capturas reales.
  GCenter funciona con las cuentas de cada usuario, leídas en su equipo.
- Comentarios que expliquen el porqué, no el qué, igual que el resto del código.

Para informar de una vulnerabilidad, consulta [SECURITY.md](SECURITY.md) en
lugar de abrir un issue público.
