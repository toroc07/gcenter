'use strict';

/**
 * Claude Code como orquestador.
 *
 * GCenter lanza el `claude` que el usuario tenga instalado y este usa la cuenta
 * con la que el usuario haya iniciado sesion. Si no la hay, el propio Claude
 * Code pide el login dentro del terminal (/login): GCenter nunca ve ni guarda
 * esas credenciales.
 */

const fs = require('fs');
const config = require('../../shared/config');
const { mcpServer, promptPath, entornoLimpio } = require('./common');

const ALLOWED_TOOLS = [
  'mcp__gcenter__agents_available',
  'mcp__gcenter__delegate',
  'mcp__gcenter__delegate_parallel',
  'mcp__gcenter__agents_running',
  'mcp__gcenter__agents_health',
  'mcp__gcenter__agents_feedback'
].join(',');

/*
 * Los ids son los alias, que Claude Code resuelve siempre a la ultima version
 * de cada familia: lo que hay que mantener al dia son solo los nombres
 * visibles. Versiones vigentes comprobadas en el propio binario de Claude Code.
 */
const MODELOS = [
  { id: 'opus', name: 'Opus 5.5', tag: 'maximo criterio' },
  { id: 'sonnet', name: 'Sonnet 5.5', tag: 'equilibrado' },
  { id: 'fable', name: 'Fable 5.1', tag: 'creativo' },
  { id: 'haiku', name: 'Haiku 4.5', tag: 'rapido y barato' }
];

/** Ordenados de menos a mas permisivo, igual que los ordena Claude. Las
 *  descripciones estan tomadas de la ayuda interna de Claude Code. */
const MODOS = [
  { id: 'plan', label: 'Plan', desc: 'solo planifica, no ejecuta ninguna herramienta' },
  { id: 'manual', label: 'Manual', desc: 'pregunta antes de cada accion' },
  { id: 'dontAsk', label: 'No preguntar', desc: 'no pregunta; deniega lo que no este aprobado de antemano' },
  { id: 'acceptEdits', label: 'Edicion automatica', desc: 'edita archivos sin preguntar' },
  { id: 'auto', label: 'Auto', desc: 'un clasificador decide que aprobar y que denegar' },
  { id: 'bypassPermissions', label: 'Sin restricciones', desc: 'se salta todas las comprobaciones de permisos' }
];

const ESFUERZOS = [
  { id: '', label: 'Por defecto de Claude' },
  { id: 'low', label: 'Bajo' },
  { id: 'medium', label: 'Medio' },
  { id: 'high', label: 'Alto' },
  { id: 'xhigh', label: 'Muy alto' },
  { id: 'max', label: 'Maximo' }
];

/** Escribe la configuracion MCP que se le pasa a claude por linea de comandos. */
function writeMcpConfig(opts) {
  const srv = mcpServer(opts);
  const cfg = { mcpServers: { gcenter: srv } };
  fs.mkdirSync(require('path').dirname(config.MCP_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(config.MCP_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return config.MCP_CONFIG_PATH;
}

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  bin: 'claude',
  install: 'npm i -g @anthropic-ai/claude-code',
  login: 'Si no has iniciado sesion, Claude Code te lo pedira en el terminal (o escribe /login).',

  modos: MODOS,
  esfuerzos: ESFUERZOS,

  /** Lo que el usuario tiene elegido para este orquestador. */
  estado(cfg) {
    return {
      model: cfg.model || 'opus',
      mode: cfg.permissionMode || 'acceptEdits',
      effort: cfg.effort || ''
    };
  },

  /** Que guardar en la configuracion al cambiar cada ajuste. */
  guardar: {
    model: (v) => ({ model: v }),
    mode: (v) => ({ permissionMode: v }),
    effort: (v) => ({ effort: v })
  },

  async modelos() {
    return MODELOS;
  },

  /** Comando para cambiar un ajuste en caliente, o null si hay que relanzar. */
  comandoEnCaliente(ajuste, valor) {
    if (ajuste === 'model') return '/model ' + valor;
    // Volver al esfuerzo por defecto no tiene comando: solo se aplica al relanzar
    if (ajuste === 'effort') return valor ? '/effort ' + valor : null;
    // El modo de permisos no se puede cambiar en marcha (shift+tab cicla y se
    // desincronizaria): se relanza reanudando la conversacion
    return null;
  },

  /**
   * Argumentos y entorno para lanzar claude.
   * @param {object} p { cfg, cwd, busPort, busToken, reanudar, promptEnLinea }
   */
  preparar(p) {
    const { cfg } = p;
    writeMcpConfig({ cwd: p.cwd, busPort: p.busPort, busToken: p.busToken, orchestratorLabel: 'Claude' });

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

    // Al relanzar por un cambio de ajuste, reanudando la conversacion el
    // usuario no pierde el hilo
    if (p.reanudar) args.push('--continue');

    // Lo lee claude, no nosotros: tiene que estar fuera del asar
    const prompt = promptPath();
    if (!p.promptEnLinea && fs.existsSync(prompt)) {
      args.push('--append-system-prompt-file', prompt);
    } else {
      let texto = '';
      try {
        texto = fs.readFileSync(prompt, 'utf8');
      } catch (e) {
        texto = '';
      }
      if (texto) args.push('--append-system-prompt', texto);
    }

    const env = entornoLimpio({
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

    return { args, env, model: cfg.model || 'opus' };
  },

  /** Si un arranque fallido se debe a un binario antiguo sin --append-system-prompt-file. */
  pideReintentoEnLinea(salida) {
    return /unknown option|opcion desconocida|error: unknown/i.test(salida);
  }
};
