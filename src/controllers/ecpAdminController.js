/**
 * ecpAdminController.js — Estado del Entorno Controlado de Pruebas, para el admin.
 *
 * Los límites del ECP se aplican desde `ecpLimits` en el camino de la cotización,
 * pero hasta ahora no había forma de MIRARLOS. Un control que rechaza operaciones
 * sin que nadie pueda ver cuánto queda es la mitad de un control: funciona, pero
 * no permite anticipar.
 *
 * Esto importa por el documento, no por comodidad. La no objeción
 * ASFI/DSC/R-184706/2026 pone entre sus criterios de aprobación que "los límites
 * autorizados sean respetados" y que exista "trazabilidad completa de
 * operaciones". Poder demostrar el consumo contra el tope, en cualquier momento,
 * es parte de eso.
 *
 * Es de solo lectura. No modifica límites ni operaciones.
 */

import { getEcpLimits, ecpLimitsEnabled, getEcpUsage, ecpPeriodStart } from '../services/ecpLimits.js';
import { logger } from '../utils/logger.js';

/**
 * Alcance autorizado, transcrito del anexo de la no objeción.
 *
 * Va en el código y no en base de datos a propósito: es un dato del expediente,
 * no una configuración. Si ASFI amplía el alcance, se cambia acá y queda en el
 * historial de versiones junto al resto del cambio.
 *
 * El valor de tenerlo a la vista es evitar la discusión de pasillo sobre si algo
 * "está dentro del ECP". Está escrito o no está.
 */
const ALCANCE = {
  resolucion:  'ASFI/DSC/R-184706/2026',
  tramite:     'T-2201402987',
  servicio:    'Sistema de Pagos Transfronterizos',
  inicio:      '2026-10-05',
  mesesPrueba: 12,

  /** Los seis flujos declarados en el anexo, punto 4. */
  flujosAutorizados: [
    'Alta del consumidor financiero',
    'Envío de persona natural por la red latinoamericana',
    'Envío de persona natural por la red internacional',
    'Envío de persona jurídica',
    'Operación no completada y devolución',
    'Reclamo del consumidor financiero',
  ],

  /**
   * Lo que el anexo NO declara. Se lista explícitamente porque la ausencia es
   * difícil de ver en una lista de presencias, y porque la pregunta "¿esto entra
   * en el ECP?" se responde mejor con las dos columnas a la vista.
   */
  fueraDelAlcance: [
    'Saldo en bolivianos como producto propio',
    'Retiro de saldo a cuenta bancaria del usuario',
    'Conversión a USDC y envíos entre usuarios',
    'Pago a comercios por QR',
  ],

  canalDeCobro: 'Pagos por canal bancario (transferencia o QR)',

  /** Advertencia textual de la carta. Es la frase que no hay que contradecir afuera. */
  advertencia: 'La no objeción no implica autorización definitiva para la prestación '
             + 'del servicio de manera masiva, habitual y permanente.',
};

/** Días transcurridos y restantes del período de prueba. */
function calendario(now) {
  const inicio = new Date(`${ALCANCE.inicio}T00:00:00-04:00`);   // hora de Bolivia
  const fin    = new Date(inicio);
  fin.setMonth(fin.getMonth() + ALCANCE.mesesPrueba);

  const dia = 24 * 60 * 60 * 1000;
  return {
    inicio:        ALCANCE.inicio,
    fin:           fin.toISOString().slice(0, 10),
    yaComenzo:     now >= inicio,
    diasTranscurridos: Math.max(0, Math.floor((now - inicio) / dia)),
    diasRestantes:     Math.max(0, Math.ceil((fin - now) / dia)),
  };
}

/**
 * Arma una fila de consumo. Un límite en 0 significa "declarado pero sin aplicar",
 * y se devuelve como tal en vez de omitirse: un tope que no se controla es
 * precisamente lo que conviene tener a la vista.
 */
function fila(etiqueta, unidad, limite, usado) {
  const aplica = limite > 0;
  return {
    etiqueta,
    unidad,
    limite:    aplica ? limite : null,
    usado:     Number(usado.toFixed ? usado.toFixed(2) : usado),
    restante:  aplica ? Math.max(0, Number((limite - usado).toFixed(2))) : null,
    usoPct:    aplica ? Number(((usado / limite) * 100).toFixed(1)) : null,
    aplicado:  aplica,
  };
}

/**
 * GET /api/v1/admin/ecp/status
 *
 * Alcance autorizado, límites, consumo y cuánto queda. Solo lectura.
 */
export async function getEcpStatus(req, res) {
  try {
    const now    = new Date();
    const limits = getEcpLimits();
    const usage  = await getEcpUsage({ now });

    const consumo = [
      fila('Monto por operación',    'BOB',         limits.perOperationMaxBOB, 0),
      fila('Monto diario',           'BOB',         limits.dailyAmountBOB,     usage.day.amount),
      fila('Operaciones diarias',    'operaciones', limits.dailyOperations,    usage.day.count),
      fila('Monto mensual',          'BOB',         limits.monthlyAmountBOB,   usage.month.amount),
      fila('Monto del período',      'BOB',         limits.periodAmountBOB,    usage.period.amount),
      fila('Operaciones del período','operaciones', limits.periodOperations,   usage.period.count),
    ];

    // Lo que hay que mirar: topes declarados ante ASFI que el sistema no hace
    // cumplir, y topes cerca de agotarse.
    const sinAplicar = consumo.filter((c) => !c.aplicado).map((c) => c.etiqueta);
    const enRiesgo   = consumo.filter((c) => c.aplicado && c.usoPct >= 80)
                              .map((c) => ({ limite: c.etiqueta, usoPct: c.usoPct }));

    return res.json({
      alcance:    ALCANCE,
      calendario: calendario(now),
      control: {
        activo:      ecpLimitsEnabled(),
        periodoDesde: ecpPeriodStart().toISOString().slice(0, 10),
      },
      consumo,
      atencion: {
        limitesSinAplicar: sinAplicar,
        limitesEnRiesgo:   enRiesgo,
        controlDesactivado: !ecpLimitsEnabled(),
      },
      generadoEn: now.toISOString(),
    });

  } catch (err) {
    logger.error('[ECP] Error al componer el estado', { error: err.message });
    return res.status(500).json({ error: 'Error al obtener el estado del ECP.' });
  }
}
