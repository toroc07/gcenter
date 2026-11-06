'use strict';

/**
 * OpenCode como orquestador.
 *
 * GCenter lanza el `opencode` que el usuario tenga instalado, con la cuenta y
 * los proveedores que el usuario haya configurado en el. Si no ha conectado
 * ninguno, OpenCode lo pide dentro del terminal (/connect): GCenter nunca ve
 * ni guarda esas credenciales.
 *
 * Todo lo que GCenter necesita (el servidor MCP, el modelo y el prompt de
 * orquestador) se inyecta en OPENCODE_CONFIG_CONTENT solo para este arranque,
 * sin tocar ~/.config/opencode ni el proyecto del usuario. Comprobado con
 * OpenCode 2.2: en la v2 los servidores MCP van bajo `mcp.servers`.
 *
 * Se arranca SIEMPRE con --standalone. Sin el, OpenCode se conecta a su
 * servicio en segundo plano, compartido por todas las sesiones del usuario:
 * nuestro servidor MCP quedaria colgado de ese servicio y no del proceso que
 * controlamos, no podriamos matarlo al reiniciar y su configuracion se
 * mezclaria con la de otras sesiones.
 */

const { execFile } = require('child_process');
const { mcpServer, promptPath, entornoLimpio } = require('./common');

/**
 * Modelos gratuitos de OpenCode: Big Pickle y los que llevan el sufijo -free.
 * Es una regla generica, no una lista: los modelos concretos se leen en cada
 * maquina con `opencode models`, y dependen de la cuenta de cada usuario.
 */
const GRATIS = /^opencode\/(big-pickle|[^/]+-free)$/;
const POR_DEFECTO_GRATIS = 'opencode/big-pickle';

const MODOS = [
  { id: 'plan', label: 'Plan', desc: 'agente plan: analiza y propone, no modifica archivos' },
  { id: 'build', label: 'Construir', desc: 'agente build con los permisos que tengas configurados en OpenCode' },
  { id: 'auto', label: 'Construir auto', desc: 'agente build aprobando todo lo que no este denegado expresamente' }
];

function esGratis(model) {
  return GRATIS.test(String(model || ''));
}

/**
 * Modelo con el que arrancar. Con el filtro de gratuidad activo, uno de pago
 * se sustituye por Big Pickle en vez de arrancar con el.
 */
function modeloEfectivo(cfg) {
  const elegido = (cfg.opencode && cfg.opencode.model) || '';
  if (cfg.freeOnly === false) return { model: elegido, aviso: null };
  if (esGratis(elegido)) return { model: elegido, aviso: null };
  return {
    model: POR_DEFECTO_GRATIS,
    aviso: elegido
      ? elegido + ' no es gratuito y el filtro de gratuidad esta activo: se usa ' + POR_DEFECTO_GRATIS + '.'
      : null
  };
}

/* Catalogo de modelos, leido con `opencode models` y guardado un rato */
let cache = null; // { at, bin, lista }
const CACHE_MS = 10 * 60 * 1000;

function listarModelos(bin) {
  if (cache && cache.bin === bin && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.lista);

  return new Promise((resolve) => {
    // El .cmd que npm crea en Windows no se puede lanzar sin shell
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    // Sin colores: el entorno del terminal fuerza FORCE_COLOR y la lista
    // llegaba envuelta en codigos ANSI que ningun id de modelo casaba
    const env = entornoLimpio({ NO_COLOR: '1' });
    delete env.FORCE_COLOR;
    execFile(bin, ['models'], { timeout: 45000, windowsHide: true, shell, env }, (err, out) => {
      const lista = String(out || '')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^[\w.-]+\/\S+$/.test(l));
      if (lista.length) cache = { at: Date.now(), bin, lista };
      resolve(lista);
    });
  });
}

module.exports = {
  id: 'opencode',
  label: 'OpenCode',
  bin: 'opencode',
  install: 'npm i -g @opencode/cli',
  login: 'Si no tienes ningun proveedor conectado, OpenCode te lo pedira en el terminal (o escribe /connect).',

  modos: MODOS,
  esfuerzos: null,
  esGratis,
  modeloEfectivo,

  estado(cfg) {
    const oc = cfg.opencode || {};
    return { model: modeloEfectivo(cfg).model, mode: oc.mode || 'build', effort: '' };
  },

  guardar: {
    model: (v) => ({ opencode: { model: v } }),
    mode: (v) => ({ opencode: { mode: v } }),
    effort: () => ({})
  },

  /**
   * Modelos para el selector. Con el filtro de gratuidad activo, solo los
   * gratuitos; sin el, todos los que el usuario tenga en OpenCode.
   */
  async modelos(bin, cfg) {
    if (!bin) return [];
    const lista = await listarModelos(bin);
    const soloGratis = cfg.freeOnly !== false;
    return lista
      .filter((m) => !soloGratis || esGratis(m))
      .map((m) => {
        const [prov, ...resto] = m.split('/');
        return { id: m, name: resto.join('/'), tag: esGratis(m) ? 'gratis' : prov };
      });
  },

  // Ni el modelo ni el modo tienen comando con argumento en OpenCode: se
  // relanza con --continue, que retoma la conversacion con los ajustes nuevos
  comandoEnCaliente() {
    return null;
  },

  /**
   * Argumentos y entorno para lanzar opencode.
   * @param {object} p { cfg, cwd, busPort, busToken, reanudar }
   */
  preparar(p) {
    const { cfg } = p;
    const oc = cfg.opencode || {};
    const srv = mcpServer({ cwd: p.cwd, busPort: p.busPort, busToken: p.busToken, orchestratorLabel: 'OpenCode' });
    const { model, aviso } = modeloEfectivo(cfg);

    const inyectada = {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        servers: {
          gcenter: {
            type: 'local',
            command: [srv.command].concat(srv.args),
            environment: srv.env,
            // Sin Code Mode las herramientas quedan a la vista con su nombre
            // (gcenter_delegate...), que es como las nombra el prompt
            codemode: false,
            // Un lote de agentes en paralelo puede tardar varios minutos
            timeout: 300000
          }
        }
      },
      // Se anade a las instrucciones del proyecto, no las sustituye
      instructions: [promptPath()]
    };
    if (model) inyectada.model = model;
    if (oc.mode === 'plan') inyectada.default_agent = 'plan';

    const args = ['--standalone'];
    if (oc.mode === 'auto') args.push('--auto');
    if (p.reanudar) args.push('--continue');
    args.push(p.cwd);

    const env = entornoLimpio({ OPENCODE_CONFIG_CONTENT: JSON.stringify(inyectada) });
    return { args, env, model: model || 'por defecto de OpenCode', aviso };
  },

  pideReintentoEnLinea() {
    return false;
  }
};
