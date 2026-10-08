'use strict';

/**
 * Salud del equipo de agentes.
 *
 * Lleva la cuenta de como se esta portando cada proveedor durante la sesion:
 * cuantas delegaciones salieron bien, cuantas fallaron, por que, y si se ha
 * quedado sin cuota. Con eso el jefe puede decidir a quien seguir mandando
 * trabajo y cuando toca arremangarse el mismo.
 *
 * Distinguimos tres estados:
 *
 *   sano       trabaja con normalidad
 *   degradado  falla a menudo o devuelve respuestas de mala calidad
 *   agotado    sin cuota o sin creditos; no tiene sentido insistir
 *
 * "Agotado" lleva un tiempo de enfriamiento porque casi siempre es temporal
 * (un limite por minuto se recupera solo). Los creditos consumidos, en cambio,
 * no vuelven durante la sesion.
 */

const FALLOS_SEGUIDOS_PARA_DEGRADAR = 3;
const ENFRIAMIENTO_CUOTA_MS = 10 * 60 * 1000; // los limites por minuto/dia se recuperan
const ENFRIAMIENTO_CREDITOS_MS = 24 * 60 * 60 * 1000; // los creditos gastados, no

const estado = new Map(); // providerId -> ficha

function ficha(providerId) {
  if (!estado.has(providerId)) {
    estado.set(providerId, {
      providerId,
      ok: 0,
      fallos: 0,
      fallosSeguidos: 0,
      avisosCalidad: 0,
      msTotal: 0,
      ultimoError: null,
      ultimoErrorEn: null,
      agotadoHasta: 0,
      motivoAgotado: null
    });
  }
  return estado.get(providerId);
}

/** Clasifica un error para saber si merece la pena reintentar con este proveedor. */
function clasificar(mensaje) {
  const m = String(mensaje || '');
  // Primero los prefijos que pone el propio cliente, que son inequivocos
  if (/^RED BLOQUEADA/.test(m)) return 'red';
  if (/^ACCESO DENEGADO/.test(m)) return 'acceso';
  if (/^LLAVE INVALIDA/.test(m)) return 'credenciales';
  if (/^SIN CREDITOS|402/i.test(m)) return 'creditos';
  if (/Cuota de .* agotada|rate.?limit|429/i.test(m)) return 'cuota';
  if (/timeout|no respondio en/i.test(m)) return 'lentitud';
  if (/restringid|reserva a aplicaciones|MODELO NO DISPONIBLE/i.test(m)) return 'modelo';
  // Ojo: un 403 NO es una llave invalida. Antes se trataba asi y un bloqueo
  // de VPN acababa diagnosticado como "la API key no es valida".
  if (/API key|401/i.test(m)) return 'credenciales';
  return 'otro';
}

function registrarExito(providerId, ms, avisosCalidad) {
  const f = ficha(providerId);
  f.ok += 1;
  f.fallosSeguidos = 0;
  f.msTotal += ms || 0;
  if (avisosCalidad) f.avisosCalidad += 1;
}

function registrarFallo(providerId, mensaje) {
  const f = ficha(providerId);
  const tipo = clasificar(mensaje);

  f.fallos += 1;
  f.ultimoError = String(mensaje || '').slice(0, 300);
  f.ultimoErrorEn = Date.now();

  // Un modelo concreto caido no dice nada del resto del proveedor: no cuenta
  // para degradarlo. Si no, dos entradas muertas de un catalogo de cincuenta
  // dejarian fuera a todo el proveedor.
  if (tipo !== 'modelo') f.fallosSeguidos += 1;
  if (tipo === 'creditos') {
    f.agotadoHasta = Date.now() + ENFRIAMIENTO_CREDITOS_MS;
    f.motivoAgotado = 'sin creditos gratuitos';
  } else if (tipo === 'cuota') {
    f.agotadoHasta = Date.now() + ENFRIAMIENTO_CUOTA_MS;
    f.motivoAgotado = 'cuota agotada';
  } else if (tipo === 'credenciales') {
    f.agotadoHasta = Date.now() + ENFRIAMIENTO_CREDITOS_MS;
    f.motivoAgotado = 'la API key no es valida';
  } else if (tipo === 'red') {
    // Depende de la red del usuario (casi siempre una VPN): se puede arreglar
    // en un minuto, asi que no lo apartamos tanto tiempo
    f.agotadoHasta = Date.now() + ENFRIAMIENTO_CUOTA_MS;
    f.motivoAgotado = 'tu red lo bloquea (¿VPN activa?)';
  } else if (tipo === 'acceso') {
    f.agotadoHasta = Date.now() + ENFRIAMIENTO_CREDITOS_MS;
    f.motivoAgotado = 'no permite este uso de su capa gratuita';
  }
  return tipo;
}

/**
 * El jefe suspendio un trabajo que tecnicamente salio bien. Cuenta para la
 * degradacion del proveedor igual que un aviso del control automatico.
 */
function registrarAvisoCalidad(providerId) {
  ficha(providerId).avisosCalidad += 1;
}

/** Un exito borra el estado de agotado: la cuota evidentemente volvio. */
function registrarRecuperacion(providerId) {
  const f = ficha(providerId);
  f.agotadoHasta = 0;
  f.motivoAgotado = null;
}

function estaAgotado(providerId) {
  const f = estado.get(providerId);
  return Boolean(f && f.agotadoHasta > Date.now());
}

function nivel(providerId) {
  const f = estado.get(providerId);
  if (!f) return 'sano';
  if (f.agotadoHasta > Date.now()) return 'agotado';
  if (f.fallosSeguidos >= FALLOS_SEGUIDOS_PARA_DEGRADAR) return 'degradado';

  // Muchas respuestas malas tambien cuentan como degradacion, aunque la
  // llamada tecnicamente funcione
  const total = f.ok + f.fallos;
  if (total >= 4 && f.avisosCalidad / total > 0.5) return 'degradado';
  return 'sano';
}

/** Foto del estado de todos los proveedores vistos hasta ahora. */
function resumen(providerIds) {
  const ids = providerIds || [...estado.keys()];
  return ids.map((id) => {
    const f = ficha(id);
    const total = f.ok + f.fallos;
    return {
      providerId: id,
      nivel: nivel(id),
      ok: f.ok,
      fallos: f.fallos,
      fallosSeguidos: f.fallosSeguidos,
      avisosCalidad: f.avisosCalidad,
      fiabilidad: total ? Math.round((f.ok / total) * 100) : null,
      msMedio: f.ok ? Math.round(f.msTotal / f.ok) : null,
      ultimoError: f.ultimoError,
      motivoAgotado: f.agotadoHasta > Date.now() ? f.motivoAgotado : null,
      minutosParaReintentar:
        f.agotadoHasta > Date.now() ? Math.ceil((f.agotadoHasta - Date.now()) / 60000) : 0
    };
  });
}

module.exports = {
  registrarExito,
  registrarAvisoCalidad,
  registrarFallo,
  registrarRecuperacion,
  estaAgotado,
  nivel,
  resumen,
  clasificar
};
