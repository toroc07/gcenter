'use strict';

/**
 * Sesion interactiva del orquestador dentro de un pseudo-terminal.
 *
 * El orquestador puede ser Claude Code u OpenCode. Esta clase no sabe nada de
 * ninguno de los dos: les pide sus argumentos y su entorno (con el servidor
 * MCP de GCenter ya configurado) y se ocupa de lo comun, que es lanzar el
 * proceso, pasarle el teclado y el tamano, y pararlo sin dejar huerfanos.
 */

const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const pty = require('@lydell/node-pty');

const config = require('../shared/config');
const { locate } = require('./locator');

const ORQUESTADORES = {
  claude: require('./orchestrators/claude'),
  opencode: require('./orchestrators/opencode')
};

function orquestador(id) {
  return ORQUESTADORES[id] || ORQUESTADORES.claude;
}

/** Ruta del ejecutable de un orquestador, respetando la que fije el usuario. */
function binDe(orq, cfg) {
  return locate(orq.bin, cfg[orq.id + 'Path']);
}

/** Que orquestadores estan instalados en esta maquina. */
function instalados(cfg) {
  const c = cfg || config.load();
  return Object.values(ORQUESTADORES).map((o) => {
    const bin = binDe(o, c);
    return { id: o.id, label: o.label, installed: Boolean(bin), path: bin, install: o.install, login: o.login };
  });
}

class Session {
  constructor(opts) {
    this.emit = opts.emit; // (channel, payload) => void
    // Solo para pruebas: fuerza un orquestador sin tocar la configuracion
    this.forzado = opts.orchestrator || null;
    this.proc = null;
    this.cols = 100;
    this.rows = 30;
    this.busPort = null;
    this.busToken = null;
    this.startedAt = null;
    this.reanudar = false;
    // Si el binario de Claude no aceptase --append-system-prompt-file,
    // reintentamos una sola vez pasando el prompt en linea
    this.promptEnLinea = false;
    this.reintentoEnLinea = false;
  }

  setBus(port, token) {
    this.busPort = port;
    this.busToken = token;
  }

  get running() {
    return Boolean(this.proc);
  }

  /** El orquestador activo segun la configuracion. */
  actual(cfg) {
    return orquestador(this.forzado || (cfg || config.load()).orchestrator);
  }

  /**
   * Si el orquestador elegido no esta instalado pero el otro si, se cambia
   * solo. Es lo que hace que un usuario nuevo con solo uno de los dos no tenga
   * que tocar nada para empezar.
   */
  resolverOrquestador(cfg) {
    const elegido = this.actual(cfg);
    const bin = binDe(elegido, cfg);
    if (bin || this.forzado) return { orq: elegido, bin, cambiado: false };

    const otro = Object.values(ORQUESTADORES).find((o) => o.id !== elegido.id && binDe(o, cfg));
    if (!otro) return { orq: elegido, bin: null, cambiado: false };

    config.save({ orchestrator: otro.id });
    return { orq: otro, bin: binDe(otro, cfg), cambiado: true, desde: elegido };
  }

  start() {
    if (this.proc) this.stop();

    const cfg = config.load();
    const { orq, bin, cambiado, desde } = this.resolverOrquestador(cfg);

    if (!bin) {
      const todos = Object.values(ORQUESTADORES);
      this.emit('session:error', {
        noInstalado: true,
        message:
          'No encuentro ' + orq.label + ' en este equipo. GCenter usa el orquestador que tengas instalado, ' +
          'con tu propia cuenta. Instala uno de estos y vuelve a abrir la sesion (Ctrl+Shift+R):\r\n' +
          todos.map((o) => '    ' + o.label + ':  ' + o.install).join('\r\n')
      });
      return false;
    }

    if (cambiado) {
      this.emit('session:data',
        '\x1b[38;5;245m[GCenter] ' + desde.label + ' no esta instalado; uso ' + orq.label + '.\x1b[0m\r\n');
    }

    const cwd = cfg.cwd && fs.existsSync(cfg.cwd) ? cfg.cwd : os.homedir();
    const prep = orq.preparar({
      cfg: config.load(),
      cwd,
      busPort: this.busPort,
      busToken: this.busToken,
      reanudar: this.reanudar,
      promptEnLinea: this.promptEnLinea
    });

    if (prep.aviso) {
      this.emit('session:data', '\x1b[38;5;245m[GCenter] ' + prep.aviso + '\x1b[0m\r\n');
    }

    // En Windows un .cmd (el envoltorio que crea npm) no se puede lanzar
    // directamente desde un pseudo-terminal: hay que pasar por cmd.exe
    let file = bin;
    let args = prep.args;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
      file = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', bin].concat(prep.args);
    }

    let proc;
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd,
        env: prep.env,
        useConpty: true
      });
    } catch (err) {
      this.emit('session:error', { message: 'No pude arrancar ' + orq.label + ': ' + err.message });
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
     * y se llevaba por delante la referencia al proceso NUEVO: el orquestador
     * seguia vivo y pintando, pero el teclado ya no le llegaba, la interfaz
     * decia "sesion cerrada" y el proceso quedaba huerfano para siempre.
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
      if (alive < 4000 && exitCode !== 0 && orq.pideReintentoEnLinea(buffer) && !this.reintentoEnLinea) {
        this.promptEnLinea = true;
        this.reintentoEnLinea = true;
        this.emit('session:data', '\r\n\x1b[33m[GCenter] Reintentando con prompt en linea...\x1b[0m\r\n');
        this.start();
        return;
      }

      this.emit('session:exit', { exitCode, alive, orchestrator: orq.label });
    });

    this.emit('session:started', {
      bin,
      cwd,
      orchestrator: orq.id,
      orchestratorLabel: orq.label,
      model: prep.model,
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
   * Cambia un ajuste del orquestador activo: 'model', 'effort' o 'mode'.
   *
   * Si el orquestador tiene comando para hacerlo en caliente, se manda. Si
   * no, se relanza reanudando la conversacion, para que el ajuste no cueste el
   * contexto. Devuelve `{ hot, running }`.
   */
  cambiarAjuste(ajuste, valor) {
    const cfg = config.load();
    const orq = this.actual(cfg);
    config.save(orq.guardar[ajuste](valor));

    const comando = orq.comandoEnCaliente(ajuste, valor);
    if (comando && this.proc) {
      this.enviarComando(comando);
      return { hot: true, running: true };
    }

    // Sin sesion viva no hay nada que relanzar: el ajuste queda guardado y la
    // interfaz decide si arrancar una
    if (!this.proc) return { hot: false, running: false };

    this.relanzar(true);
    return { hot: false, running: this.running };
  }

  /** Para y vuelve a arrancar, opcionalmente retomando la conversacion. */
  relanzar(reanudar) {
    const habiaConversacion = Boolean(this.proc);
    this.stop();
    this.reanudar = Boolean(reanudar) && habiaConversacion;
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

    // El orquestador lanza a su vez el servidor MCP de GCenter. Matar solo al
    // orquestador puede dejar ese hijo vivo, asi que tumbamos el arbol entero.
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
      // En Linux y macOS el pseudo-terminal arranca al orquestador como lider
      // de su propio grupo de procesos, asi que un pid negativo alcanza a todo
      // el grupo
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

module.exports = { Session, ORQUESTADORES, orquestador, binDe, instalados };
