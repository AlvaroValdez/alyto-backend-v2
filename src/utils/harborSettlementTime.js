/**
 * harborSettlementTime.js — Plazo REAL de liquidación que declara Harbor.
 *
 * La cotización de Harbor devuelve el plazo como RANGO CON UNIDAD:
 *
 *   settlement_time_min / fiat_settlement_time_min
 *   settlement_time_max / fiat_settlement_time_max
 *   settlement_time_unit / fiat_settlement_time_unit
 *
 * `owlPayService.js` ya los normaliza en dos sitios (líneas 349-351 y 1078-1080)
 * y hasta ahora NADIE los consumía: se extraían y se tiraban. El plazo que se le
 * mostraba al usuario salía de un ternario hardcodeado sobre `payinMethod`.
 *
 * Es mejor dato que el de Vita, que publica un número único: acá viene el rango,
 * que es exactamente la forma que necesita el texto aproximado.
 *
 * ── La unidad es lo peligroso ───────────────────────────────────────────────────
 *
 * No hay en el repo ninguna respuesta real que fije los valores de
 * `settlement_time_unit`, así que la conversión es defensiva y, ante una unidad
 * que no se reconoce, devuelve null en vez de asumir.
 *
 * Leer "48" con unidad desconocida como 48 DÍAS cuando son 48 HORAS, o al revés,
 * es un error de dos órdenes de magnitud en una promesa al consumidor. Más vale
 * marcar el corredor como no verificado y caer al tramo del ECP.
 *
 * ── Dirección conservadora de la conversión ─────────────────────────────────────
 *
 * Los días calendario se tratan como hábiles. 3 días calendario que cruzan un fin
 * de semana son menos de 3 hábiles, así que contarlos como hábiles produce un
 * vencimiento MÁS TARDÍO. Un plazo informado de más genera una consulta; uno de
 * menos, un incumplimiento.
 */

const HORA = new Set(['hour', 'hours', 'hr', 'hrs', 'h']);
const DIA  = new Set(['day', 'days', 'd', 'business_day', 'business_days', 'businessday', 'businessdays', 'calendar_day', 'calendar_days']);

/** Entero >= 0, o null. Un dato roto NO vale cero. */
function entero(v) {
  if (v == null || v === '' || typeof v === 'object') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Convierte el plazo de Harbor a días hábiles.
 *
 * @param {{settlementTimeMin?:*, settlementTimeMax?:*, settlementTimeUnit?:*}} q
 *        cotización ya normalizada por owlPayService
 * @returns {{min:number, max:number}|null}  null si falta el dato o la unidad no
 *          se reconoce. El resolver lo marca como no verificado.
 */
export function harborSettlementToBusinessDays(q) {
  if (!q) return null;

  const unidadRaw = q.settlementTimeUnit;
  if (typeof unidadRaw !== 'string' || unidadRaw.trim() === '') return null;
  const unidad = unidadRaw.trim().toLowerCase();

  const max = entero(q.settlementTimeMax);
  if (max === null) return null;                       // el máximo es el que compromete
  const min = Math.min(entero(q.settlementTimeMin) ?? 0, max);

  if (HORA.has(unidad)) {
    // Menos de 24 h es el mismo día hábil. A partir de ahí se redondea hacia
    // ARRIBA: 25 h no caben en un día hábil.
    return { min: min < 24 ? 0 : Math.ceil(min / 24), max: max < 24 ? 0 : Math.ceil(max / 24) };
  }

  if (DIA.has(unidad)) {
    return { min: Math.trunc(min), max: Math.trunc(max) };
  }

  // Unidad desconocida: no se adivina.
  return null;
}

export default { harborSettlementToBusinessDays };
