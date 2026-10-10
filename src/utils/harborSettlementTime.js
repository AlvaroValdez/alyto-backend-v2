/**
 * harborSettlementTime.js — Plazo REAL de liquidación que declara Harbor.
 *
 * La cotización de Harbor devuelve el plazo como RANGO CON UNIDAD:
 *
 *   fiat_settlement_time_min / settlement_time_min
 *   fiat_settlement_time_max / settlement_time_max
 *   fiat_settlement_time_unit / settlement_time_unit
 *
 * `owlPayService.js` ya los normalizaba (líneas 349-351 y 1078-1080) y NADIE los
 * consumía: se extraían y se tiraban, mientras el plazo mostrado al usuario salía
 * de un ternario hardcodeado sobre `payinMethod`.
 *
 * ── Valores REALES, sondeados contra el sandbox el 2026-10-10 ───────────────────
 *
 * No se asumen: se preguntaron. Una cotización por ruta (POST de quotes, no crea
 * transferencia):
 *
 *   US/USD  ACH Push            2–5   DAYS
 *   US/USD  Fedwire             1–1   DAYS
 *   US/USD  Domestic Wire       0–2   DAYS
 *   US/USD  International Wire  1–3   DAYS
 *   GB/GBP  Bank Transfer       0–2   DAYS
 *   SG/SGD  Bank Transfer       1–15  MINUTES
 *   NG/NGN  Bank Transfer       1–5   MINUTES
 *   BR/USD  International Wire  1–3   DAYS
 *
 * Dos cosas que eso enseña y que no estaban en ninguna suposición previa:
 *   1. La unidad viene en MAYÚSCULAS y existe MINUTES. Hay rutas que liquidan en
 *      minutos, no en días.
 *   2. El plazo es POR MÉTODO, no por país: en US, ACH Push tarda 2–5 días y
 *      Fedwire 1. Elegir el riel más barato puede ser elegir el más lento.
 *
 * ── Se preserva la granularidad real, pero NO se publica ───────────────────────
 *
 * Esta función devuelve el rango en su unidad canónica y, aparte, la conversión a
 * días hábiles. El rango fino sirve para medición interna y visibilidad de admin.
 *
 * ⚠️ NO se le muestra al usuario. Decisión de Alvaro (2026-10-10): no se
 * comprometen plazos acotados. Publicar "1 a 15 minutos" para Singapur sería
 * convertir una estimación del proveedor en una promesa nuestra, cuando por encima
 * de su plazo están nuestra confirmación del cobro, la conversión y el despacho.
 * El texto publicable lo arma `plazoPublicado.plazoTexto`, cuyo piso de
 * granularidad es el día hábil: todo lo sub-diario dice "el mismo día hábil".
 *
 * ── Unidad desconocida: no se adivina ─────────────────────────────────────────
 *
 * Leer "48" como 48 DÍAS cuando son 48 HORAS es un error de dos órdenes de
 * magnitud en una promesa al consumidor. Toda unidad fuera del mapa devuelve null
 * y el corredor queda marcado como no verificado.
 */

/** Unidad de Harbor → unidad canónica + minutos que vale una de esas unidades. */
const UNIDADES = new Map([
  ['second',        ['minutes', 1 / 60]], ['seconds',       ['minutes', 1 / 60]],
  ['minute',        ['minutes', 1]],      ['minutes',       ['minutes', 1]],
  ['hour',          ['hours',   60]],     ['hours',         ['hours',   60]],
  ['day',           ['days',    1440]],   ['days',          ['days',    1440]],
  ['business_day',  ['days',    1440]],   ['business_days', ['days',    1440]],
  ['businessday',   ['days',    1440]],   ['businessdays',  ['days',    1440]],
  ['calendar_day',  ['days',    1440]],   ['calendar_days', ['days',    1440]],
]);

const MIN_POR_DIA = 1440;

/** Entero/decimal >= 0, o null. Un dato roto NO vale cero. */
function num(v) {
  if (v == null || v === '' || typeof v === 'object') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Plazo de Harbor normalizado, preservando su unidad real.
 *
 * @param {{settlementTimeMin?:*, settlementTimeMax?:*, settlementTimeUnit?:*}} q
 * @returns {{min:number, max:number, unit:'minutes'|'hours'|'days',
 *            minBusinessDays:number, maxBusinessDays:number}|null}
 */
export function harborSettlementRange(q) {
  if (!q) return null;

  const unidadRaw = q.settlementTimeUnit;
  if (typeof unidadRaw !== 'string' || unidadRaw.trim() === '') return null;
  const mapeo = UNIDADES.get(unidadRaw.trim().toLowerCase());
  if (!mapeo) return null;                             // unidad desconocida: no se adivina
  const [unit, minutosPorUnidad] = mapeo;

  const max = num(q.settlementTimeMax);
  if (max === null) return null;                       // el máximo es el que compromete
  const min = Math.min(num(q.settlementTimeMin) ?? 0, max);

  // A días hábiles para la fecha límite. Por debajo de un día es el mismo día
  // hábil; por encima se redondea hacia ARRIBA, porque 25 h no caben en un día.
  const aDias = (v) => {
    const minutos = v * minutosPorUnidad;
    return minutos < MIN_POR_DIA ? 0 : Math.ceil(minutos / MIN_POR_DIA);
  };

  return {
    min, max, unit,
    minBusinessDays: aDias(min),
    maxBusinessDays: aDias(max),
  };
}

export default { harborSettlementRange };
