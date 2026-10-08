'use strict';

/**
 * Gestiona la sesion interactiva de Claude Code dentro de un pseudo-terminal.
 *
 * Antes de arrancarla genera el fichero mcp.json que le da acceso a las
 * herramientas de delegacion de GCenter, y le inyecta el prompt de orquestador
 * para que se comporte como jefe del equipo de agentes.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pty = require('@lydell/node-pty');

const config = require('../shared/config');
const { locate } = require('./claude-locator');

/**
 * Variables que describen una sesion de Claude Code PADRE.
 *
 * Si GCenter se abre desde un terminal que ya es una sesion de Claude Code
 * (el integrado de VS Code con la extension, por ejemplo), hereda estas
 * variables y se las pasaria a su propio Claude, que entonces se cree una
 * subsesion: deja de guardar la conversacion (y con ello deja de funcionar
 * --continue), se conecta al canal de mensajeria de la otra sesion y adopta
 * su nivel de esfuerzo en vez del que eligio el usuario. Se quitan solo las
 * que marcan estado de sesion; la configuracion del usuario (proveedor,
 * rutas, tokens de acceso) se respeta.
 */
const HERENCIA_DE_SESION = [
  /^CLAUDECODE$/,
  /^CLAUDE_PID$/,
  /^CLAUDE_EFFORT$/,
  /^CLAUDE_AGENT_SDK_/,
  /^CLAUDE_CODE_(CHILD_SESSION|SESSION_|MESSAGING_|ENTRYPOINT|EXECPATH|SSE_PORT|EMIT_STARTUP_TIMING|ENABLE_TASKS|ENABLE_SDK_|QUESTION_PREVIEW)/,
  /^MCP_CONNECTION_NONBLOCKING$/
];

const ALLOWED_TOOLS = [
  'mcp__gcenter__agents_available',
  'mcp__gcenter__delegate',
  'mcp__gcenter__delegate_parallel',
  'mcp__gcenter__agents_running',
  'mcp__gcenter__agents_health',
  'mcp__gcenter__agents_feedback'
].join(',');

/**
 * Dentro de un .exe empaquetado los recursos viven en app.asar. Electron sabe
 * leer de ahi, asi que sus propios ficheros se resuelven tal cual.
 */
function resolveResource(rel) {
  return path.join(__dirname, '..', rel);
}

/**
 * Ruta para ficheros que va a abrir un proceso ajeno a Electron. claude.exe no
 * entiende el formato asar, asi que estos recursos se declaran en `asarUnpack`
 * y se sirven desde la carpeta desempaquetada de al lado.
 */
function resolveExternalResource(rel) {
  return resolveResource(rel).replace(
    'app.asar' + path.sep,
    'app.asar.unpacked' + path.sep
  );
}

/** Escribe la configuracion MCP que le pasaremos a claude por linea de comandos. */
function writeMcpConfig(busPort, busToken, cwd) {
  const serverPath = resolveResource(path.join('mcp', 'server.js'));

  const cfg = {
    mcpServers: {
      gcenter: {
        command: process.execPath,
        args: [serverPath],
        env: {
          // Hace que el propio Electron actue como runtime de Node, asi el .exe
          // portable no depende de que el usuario tenga Node instalado
          ELECTRON_RUN_AS_NODE: '1',
          // Anclamos el directorio de configuracion en vez de dejar que el
          // servidor MCP lo deduzca: asi lee las mismas llaves que la interfaz
          // aunque herede un entorno distinto del nuestro
          GCENTER_HOME: config.configDir(),
          // Los agentes leen y escriben archivos del proyecto: tienen que saber
          // cual es, y quedarse dentro de el
          GCENTER_CWD: cwd,
          GCENTER_BUS_PORT: String(busPort),
          GCENTER_BUS_TOKEN: busToken
        }
      }
    }
  };

  fs.mkdirSync(path.dirname(config.MCP_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(config.MCP_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return config.MCP_CONFIG_PATH;
}

class ClaudeSession {
  constructor(opts) {
    this.emit = opts.emit; // (channel, payload) => void
    this.proc = null;
    this.cols = 100;
    this.rows = 30;
    this.busPort = null;
    this.busToken = null;
    this.startedAt = null;
    // Si el binario no aceptase --append-system-prompt-file, reintentamos una
    // sola vez pasando el prompt en linea
    this.useSystemPromptFile = true;
    this.retriedInline = false;
  }

  setBus(port, token) {
    this.busPort = port;
    this.busToken = token;
  }

  get running() {
    return Boolean(this.proc);
  }

  buildArgs(cfg) {
    // Lo lee claude.exe, no nosotros: tiene que estar fuera del asar
    const promptPath = resolveExternalResource(path.join('..', 'prompts', 'orchestrator.md'));
    const modo = cfg.permissionMode || 'acceptEdits';
    const args = [
      '--mcp-config', config.MCP_CONFIG_PATH,
      '--model', cfg.model || 'opus',
      '--permission-mode', modo,
      '--allowedTools', ALLOWED_TOOLS,
      '--name', 'GCenter'
    ];

    // Saltarse los permisos no basta con pedirlo en --permission-mode: Claude
    // exige ademas habilitarlo explicitamente, o el modo no llega a aplicarse
    if (modo === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions');

    // Sin esfuerzo elegido no pasamos el flag, para no pisar el valor por
    // defecto que Claude aplica segun el modelo
    if (cfg.effort) args.push('--effort', cfg.effort);

    // Al cambiar de modo de permisos hay que relanzar el proceso, porque no
    // existe comando para cambiarlo en marcha. Reanudando la conversacion el
    // usuario no pierde el hilo por un ajuste.
    if (this.reanudar) args.push('--continue');

    if (this.useSystemPromptFile && fs.existsSync(promptPath)) {
      args.push('--append-system-prompt-file', promptPath);
    } else {
      let text = '';
      try {
        text = fs.readFileSync(promptPath, 'utf8');
      } catch (e) {
        text = '';
      }
      if (text) args.push('--append-system-prompt', text);
    }

    return args;
  }

  start() {
    if (this.proc) this.stop();

    const cfg = config.load();
    const bin = locate(cfg.claudePath);

    if (!bin) {
      this.emit('session:error', {
        message:
          'No encuentro Claude Code. Instalalo con "npm i -g @anthropic-ai/claude-code" ' +
          'o indica su ruta en Ajustes.'
      });
      return false;
    }

    const cwd = cfg.cwd && fs.existsSync(cfg.cwd) ? cfg.cwd : require('os').homedir();
    writeMcpConfig(this.busPort, this.busToken, cwd);

    const env = Object.assign({}, process.env, {
      // Que Claude no herede el modo "ejecutar como node" de Electron
      ELECTRON_RUN_AS_NODE: undefined,
      FORCE_COLOR: '3',
      TERM: 'xterm-256color',
      // Un lote de agentes en paralelo puede tardar mas que el tope por
      // defecto de las herramientas MCP, y Claude lo cortaria a medias
      MCP_TIMEOUT: '30000',
      MCP_TOOL_TIMEOUT: '300000',
      // Claude Code "difiere" las herramientas MCP cuando hay muchas: solo ve
      // sus nombres y tiene que buscarlas antes de usarlas. En la practica eso
      // significaba que ni se acordaba de que existian los agentes y se ponia
      // a escribir el solo. Desactivandolo, las herramientas de delegacion
      // estan a la vista desde el primer mensaje.
      ENABLE_TOOL_SEARCH: 'false'
    });
    delete env.ELECTRON_RUN_AS_NODE;
    for (const k of Object.keys(env)) {
      if (HERENCIA_DE_SESION.some((re) => re.test(k))) delete env[k];
    }

    let proc;
    try {
      proc = pty.spawn(bin, this.buildArgs(cfg), {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd,
        env,
        useConpty: true
      });
    } catch (err) {
      this.emit('session:error', { message: 'No pude arrancar Claude: ' + err.message });
      return false;
    }

    this.proc = proc;
    this.startedAt = Date.now();
    const inicio = this.startedAt;
    let buffer = '';

    /*
     * Cada manejador comprueba que su proceso sigue siendo el actual.
     *
     * Al reiniciar matamos el proceso viejo y arrancamos uno nuevo en el acto,
     * pero el aviso de salida del viejo llega despues, cuando el nuevo ya esta
     * en marcha. Sin esta comprobacion, ese aviso tardio ponia this.proc a null
     * y se llevaba por delante la referencia al proceso NUEVO: Claude seguia
     * vivo y pintando, pero el teclado ya no le llegaba, la interfaz decia
     * "sesion cerrada" y el proceso quedaba huerfano para siempre.
     */
    proc.onData((data) => {
      // Un proceso sustituido aun puede soltar sus ultimos fotogramas: no deben
      // pintarse encima de la sesion nueva
      if (this.proc !== proc) return;
      // Solo guardamos el principio, para poder detectar un arranque fallido
      if (buffer.length < 4000) buffer += data;
      this.emit('session:data', data);
    });

    proc.onExit(({ exitCode }) => {
      if (this.proc !== proc) return;

      const alive = Date.now() - inicio;
      this.proc = null;

      // Murio al instante y se quejo de la opcion: el binario es antiguo,
      // reintentamos con el prompt en linea
      const unknownOption = /unknown option|opcion desconocida|error: unknown/i.test(buffer);
      if (alive < 4000 && exitCode !== 0 && unknownOption && this.useSystemPromptFile && !this.retriedInline) {
        this.useSystemPromptFile = false;
        this.retriedInline = true;
        this.emit('session:data', '\r\n\x1b[33m[GCenter] Reintentando con prompt en linea...\x1b[0m\r\n');
        this.start();
        return;
      }

      this.emit('session:exit', { exitCode, alive });
    });

    this.emit('session:started', {
      bin,
      cwd,
      model: cfg.model,
      pid: proc.pid
    });
    return true;
  }

  write(data) {
    if (this.proc) this.proc.write(data);
  }

  resize(cols, rows) {
    this.cols = Math.max(20, cols | 0);
    this.rows = Math.max(5, rows | 0);
    if (this.proc) {
      try {
        this.proc.resize(this.cols, this.rows);
      } catch (e) {
        /* la sesion puede estar muriendose */
      }
    }
  }

  /**
   * Cambio de modelo en caliente: limpiamos la linea de entrada por si el
   * usuario estaba escribiendo y mandamos el comando /model.
   */
  switchModel(model) {
    config.save({ model });
    return this.enviarComando('/model ' + model);
  }

  /**
   * Cambio de esfuerzo en caliente. Volver al automatico no tiene comando
   * equivalente, asi que en ese caso solo se guarda para el proximo arranque.
   */
  switchEffort(effort) {
    config.save({ effort });
    if (!effort) return false;
    return this.enviarComando('/effort ' + effort);
  }

  /**
   * Cambia el modo de permisos. Requiere relanzar Claude, pero reanudando la
   * conversacion en curso para que el cambio no cueste el contexto.
   */
  setPermissionMode(mode) {
    config.save({ permissionMode: mode });
    const habiaConversacion = Boolean(this.proc);
    this.stop();
    this.reanudar = habiaConversacion;
    const ok = this.start();
    this.reanudar = false;
    return ok;
  }

  /** Limpia lo que hubiera escrito el usuario y manda un comando de barra. */
  enviarComando(texto) {
    if (!this.proc) return false;
    this.proc.write('\x15'); // Ctrl+U: borra la linea actual
    this.proc.write(texto + '\r');
    return true;
  }

  stop() {
    if (!this.proc) return;
    const proc = this.proc;
    // Primero soltamos la referencia: a partir de aqui cualquier dato o aviso
    // de salida de este proceso se ignora
    this.proc = null;

    // Claude lanza a su vez el servidor MCP de GCenter. Matar solo a Claude
    // puede dejar ese hijo vivo, asi que tumbamos el arbol entero.
    if (process.platform === 'win32' && proc.pid) {
      try {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        }).on('error', () => {});
      } catch (e) {
        /* si taskkill no esta, nos quedamos con el kill normal */
      }
    } else if (proc.pid) {
      // En Linux el pseudo-terminal arranca a Claude como lider de su propio
      // grupo de procesos, asi que un pid negativo alcanza a todo el grupo
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch (e) {
        /* el grupo ya no existe */
      }
    }

    try {
      proc.kill();
    } catch (e) {
      /* ya estaba muerto */
    }
  }
}

module.exports = { ClaudeSession };
