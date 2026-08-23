/**
 * ecpLimits.js — Límites agregados del Entorno Controlado de Pruebas (ASFI).
 *
 * El Protocolo de Pruebas declara OCHO límites ante ASFI. Antes de este módulo el
 * sistema aplicaba dos —mínimo y máximo por operación, por corredor— y los seis
 * agregados no existían en ninguna parte:
 *
 *     por operación   mín Bs 400 · máx Bs 120.000        ← ya existía (TransactionConfig)
 *     diario          Bs 170.000                         ← NO existía
 *     período         Bs 8.000.000 · 6.000 operaciones   ← NO existía
 *     consumidores    630                                ← NO existía
 *
 * El máximo diario se fija por DEBAJO de la capacidad diaria de adquisición de activo
 * digital (Bs 174.000), que es la restricción operativa efectiva del servicio: un tope
 * superior admitiría operaciones cobradas que no se podrían liquidar en plazo.
 *
 * Conteo diario y tope mensual quedan en 0 —desactivados— porque el Protocolo vigente
 * no los declara. `evaluateEcpLimits` ignora todo límite en 0, así que reactivarlos es
 * cambiar el valor, sin tocar la lógica.
 *
 * Por qué importa: el Art. 13° inc. f de la Sección 5 hace del EXCESO DE LÍMITES una
 * causal de rechazo del servicio, y el Art. 8° exige que las pruebas se realicen en
 * condiciones "limitadas y controladas". Un límite que se declara pero no se aplica no
 * es un límite: es una expectativa. Este módulo lo convierte en control técnico.
 *
 * ── Decisiones de diseño, con su fundamento ─────────────────────────────────────
 *
 * 1. FAIL-CLOSED. Si la agregación falla, se RECHAZA la operación. Es lo contrario del
 *    guard de liquidez (que permite ante un Horizon caído, ver treasuryLiquidity) y es
 *    deliberado: allí la falla impide VERIFICAR un riesgo ya acotado por el cobro
 *    previo; acá la falla impide verificar un límite REGULATORIO cuyo exceso es causal
 *    de rechazo. El criterio está declarado en el informe técnico, apdo. 11.3.1.
 *
 * 2. CUENTA CONSERVADORA. Consumen límite todas las operaciones salvo las que
 *    terminaron sin ejecutarse (failed/refunded/cancelled). Se incluyen las pendientes:
 *    ante la duda se bloquea antes, no después. Con el volumen del ECP el
 *    sobre-bloqueo no es un riesgo práctico; el sub-bloqueo sí es causal de rechazo.
 *
 * 3. SIN TOPES SILENCIOSOS. Todo rechazo devuelve el límite, el consumo y el
 *    remanente. Nada se recorta sin decirlo — mismo criterio que el resto del sistema.
 *
 * 4. GATE. `ECP_LIMITS_ENABLED` permite desactivarlo. Por defecto está ACTIVO: un
 *    control regulatorio no debe depender de que alguien recuerde encenderlo. Se
 *    apaga explícitamente, no se enciende explícitamente.
 */

import Transaction from '../models/Transaction.js';
import { logger }  from '../utils/logger.js';

/** Estados que NO consumen límite: la operación terminó sin ejecutarse. */
const NON_CONSUMING_STATUSES = ['failed', 'refunded', 'cancelled'];

/** Lee un entero de entorno con valor por defecto del Protocolo de Pruebas. */
function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Límites declarados ante ASFI. Los valores por defecto son los del Protocolo de
 * Pruebas; las variables permiten ajustarlos si ASFI fija otros en la no objeción,
 * sin necesidad de redesplegar código.
 */
export function getEcpLimits() {
  return {
    perOperationMaxBOB: envInt('ECP_MAX_PER_OPERATION_BOB', 120_000),
    dailyAmountBOB:     envInt('ECP_MAX_DAILY_BOB',         170_000),
    dailyOperations:    envInt('ECP_MAX_DAILY_OPS',                0),  // sin tope de conteo diario
    monthlyAmountBOB:   envInt('ECP_MAX_MONTHLY_BOB',              0),  // el Protocolo no declara tope mensual
    periodAmountBOB:    envInt('ECP_MAX_PERIOD_BOB',       8_000_000),
    periodOperations:   envInt('ECP_MAX_PERIOD_OPS',           6_000),
    maxConsumers:       envInt('ECP_MAX_CONSUMERS',              630),
  };
}

export function ecpLimitsEnabled() {
  // Activo salvo desactivación explícita — ver decisión 4 de la cabecera.
  return process.env.ECP_LIMITS_ENABLED !== 'false';
}

/**
 * Inicio del período del ECP. Sin configurar, se toma el epoch: el acumulado de
 * período incluye todo lo registrado, que es la lectura conservadora mientras la
 * carta de no objeción no fije la fecha de inicio (Art. 5°).
 */
export function ecpPeriodStart() {
  const raw = process.env.ECP_PERIOD_START;
  if (!raw) return new Date(0);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

/** Inicio del día calendario de `now`. */
function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Inicio del mes calendario de `now`. */
function startOfMonth(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d;
}

/**
 * Consumo agregado de los límites, en la moneda de origen (BOB) del perímetro SRL.
 *
 * Una sola agregación con $facet: tres ventanas sobre el mismo conjunto, para no
 * disparar tres consultas por operación.
 *
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<{ day:{amount:number,count:number}, month:{amount:number,count:number},
 *                     period:{amount:number,count:number} }>}
 */
export async function getEcpUsage({ now = new Date() } = {}) {
  const periodStart = ecpPeriodStart();

  const base = {
    legalEntity:    'SRL',
    originCurrency: 'BOB',
    status:         { $nin: NON_CONSUMING_STATUSES },
    createdAt:      { $gte: periodStart },
  };

  const sum = { $sum: { $ifNull: ['$originAmount', 0] } };

  const [facet] = await Transaction.aggregate([
    { $match: base },
    {
      $facet: {
        day:    [{ $match: { createdAt: { $gte: startOfDay(now)   } } }, { $group: { _id: null, amount: sum, count: { $sum: 1 } } }],
        month:  [{ $match: { createdAt: { $gte: startOfMonth(now) } } }, { $group: { _id: null, amount: sum, count: { $sum: 1 } } }],
        period: [                                                        { $group: { _id: null, amount: sum, count: { $sum: 1 } } }],
      },
    },
  ]);

  const pick = (arr) => ({
    amount: Number(arr?.[0]?.amount ?? 0),
    count:  Number(arr?.[0]?.count  ?? 0),
  });

  return {
    day:    pick(facet?.day),
    month:  pick(facet?.month),
    period: pick(facet?.period),
  };
}

/**
 * Evalúa una operación contra los límites agregados. FUNCIÓN PURA — sin acceso a
 * datos, para poder probarla exhaustivamente sin base.
 *
 * @param {{ amountBOB:number, usage:object, limits:object }} p
 * @returns {{ allowed:boolean, violation:object|null }}
 */
export function evaluateEcpLimits({ amountBOB, usage, limits }) {
  const amount = Number(amountBOB) || 0;

  const checks = [
    { code: 'ECP_OPERATION_LIMIT', scope: 'operación', unit: 'BOB',
      limit: limits.perOperationMaxBOB, used: 0,                  incoming: amount },
    { code: 'ECP_DAILY_AMOUNT_LIMIT', scope: 'diario', unit: 'BOB',
      limit: limits.dailyAmountBOB,     used: usage.day.amount,    incoming: amount },
    { code: 'ECP_DAILY_COUNT_LIMIT', scope: 'diario', unit: 'operaciones',
      limit: limits.dailyOperations,    used: usage.day.count,     incoming: 1 },
    { code: 'ECP_MONTHLY_AMOUNT_LIMIT', scope: 'mensual', unit: 'BOB',
      limit: limits.monthlyAmountBOB,   used: usage.month.amount,  incoming: amount },
    { code: 'ECP_PERIOD_AMOUNT_LIMIT', scope: 'período', unit: 'BOB',
      limit: limits.periodAmountBOB,    used: usage.period.amount, incoming: amount },
    { code: 'ECP_PERIOD_COUNT_LIMIT', scope: 'período', unit: 'operaciones',
      limit: limits.periodOperations,   used: usage.period.count,  incoming: 1 },
  ];

  for (const c of checks) {
    if (!(c.limit > 0)) continue;
    if (c.used + c.incoming > c.limit) {
      return {
        allowed:   false,
        violation: {
          code:      c.code,
          scope:     c.scope,
          unit:      c.unit,
          limit:     c.limit,
          used:      Number(c.used.toFixed ? c.used.toFixed(2) : c.used),
          requested: c.incoming,
          remaining: Math.max(0, Number((c.limit - c.used).toFixed(2))),
        },
      };
    }
  }

  return { allowed: true, violation: null };
}

/**
 * Verificación completa, para invocar antes de crear la operación.
 *
 * FAIL-CLOSED: si la agregación falla, devuelve `allowed:false` con código
 * `ECP_LIMIT_CHECK_UNAVAILABLE`. Ver decisión 1 de la cabecera.
 *
 * @param {{ amountBOB:number, now?:Date }} p
 * @returns {Promise<{ allowed:boolean, violation:object|null, limits:object, usage:object|null }>}
 */
export async function checkEcpLimits({ amountBOB, now = new Date() }) {
  const limits = getEcpLimits();

  if (!ecpLimitsEnabled()) {
    return { allowed: true, violation: null, limits, usage: null };
  }

  let usage;
  try {
    usage = await getEcpUsage({ now });
  } catch (err) {
    logger?.error?.('[ECP] No se pudo calcular el consumo de límites — se rechaza por defecto', {
      err: err.message,
    });
    return {
      allowed:   false,
      violation: { code: 'ECP_LIMIT_CHECK_UNAVAILABLE', scope: 'verificación', unit: null,
                   limit: null, used: null, requested: amountBOB, remaining: null },
      limits,
      usage: null,
    };
  }

  const { allowed, violation } = evaluateEcpLimits({ amountBOB, usage, limits });
  return { allowed, violation, limits, usage };
}

/** Mensaje al consumidor. No expone el consumo agregado de la plataforma. */
export function ecpViolationMessage(violation) {
  if (!violation) return null;
  if (violation.code === 'ECP_LIMIT_CHECK_UNAVAILABLE') {
    return 'No fue posible verificar los límites operativos en este momento. Intentá nuevamente en unos minutos.';
  }
  if (violation.unit === 'operaciones') {
    return `Se alcanzó el número máximo de operaciones ${violation.scope} previsto para el Entorno Controlado de Pruebas.`;
  }
  return `La operación excede el límite ${violation.scope} previsto para el Entorno Controlado de Pruebas.`;
}

export default {
  getEcpLimits,
  ecpLimitsEnabled,
  ecpPeriodStart,
  getEcpUsage,
  evaluateEcpLimits,
  checkEcpLimits,
  ecpViolationMessage,
};
