/**
 * ecpTramos.js — Tramos de operación y plazo de liquidación comprometido.
 *
 * El Protocolo de Pruebas estructura el servicio en tres tramos según el importe, y a
 * cada uno le asigna un plazo máximo de liquidación distinto. El plazo **se informa al
 * consumidor antes de que confirme** (apdo. 5.7 del Informe Técnico, Art. 9° Sec. 5).
 *
 * Esa anterioridad es lo que hace admisible el ticket máximo de Bs 120.000: un plazo
 * más extenso sólo es defendible si el consumidor lo conoce antes de transferir, no
 * después. Sin este dato en la cotización, el tramo corporativo no se sostiene.
 *
 *   Estándar     Bs    400 –  20.000    mismo día hábil
 *   Ampliado     Bs 20.001 –  70.000    hasta 1 día hábil
 *   Corporativo  Bs 70.001 – 120.000    hasta 2 días hábiles
 *
 * Función pura y sin dependencias: el tramo se calcula igual en el cálculo de la
 * cotización, al crear la operación y al mostrarla, sin riesgo de divergir.
 */

/** Definición canónica. El orden importa: se evalúa de menor a mayor. */
export const ECP_TRAMOS = Object.freeze([
  Object.freeze({
    id:        'estandar',
    nombre:    'Estándar',
    minBOB:    400,
    maxBOB:    20_000,
    diasHabiles: 0,
    plazoTexto:  'Mismo día hábil',
  }),
  Object.freeze({
    id:        'ampliado',
    nombre:    'Ampliado',
    minBOB:    20_001,
    maxBOB:    70_000,
    diasHabiles: 1,
    plazoTexto:  'Hasta 1 día hábil',
  }),
  Object.freeze({
    id:        'corporativo',
    nombre:    'Corporativo',
    minBOB:    70_001,
    maxBOB:    120_000,
    diasHabiles: 2,
    plazoTexto:  'Hasta 2 días hábiles',
  }),
]);

export const ECP_TRAMO_IDS = ECP_TRAMOS.map(t => t.id);

/**
 * Resuelve el tramo de un importe en bolivianos.
 *
 * Devuelve `null` fuera de rango —por debajo del mínimo o por encima del máximo—
 * en lugar de asignar el tramo más cercano: un importe fuera de rango debe ser
 * rechazado por el control de límites, no acomodado a un tramo.
 *
 * @param {number} amountBOB
 * @returns {{id:string, nombre:string, diasHabiles:number, plazoTexto:string,
 *            minBOB:number, maxBOB:number}|null}
 */
export function resolveTramo(amountBOB) {
  const monto = Number(amountBOB);
  if (!Number.isFinite(monto)) return null;
  return ECP_TRAMOS.find(t => monto >= t.minBOB && monto <= t.maxBOB) ?? null;
}

/**
 * Suma días hábiles (lun–vie). Cero días devuelve el mismo día.
 *
 * No contempla feriados, y es deliberado: el plazo calculado vence ANTES que el real,
 * nunca después. Un vencimiento adelantado genera una alerta temprana; uno atrasado
 * incumple un plazo informado al consumidor.
 */
export function addBusinessDays(from, days) {
  const d = new Date(from);
  const paso = days >= 0 ? 1 : -1;
  let restantes = Math.abs(days);
  while (restantes > 0) {
    d.setDate(d.getDate() + paso);
    if (d.getDay() !== 0 && d.getDay() !== 6) restantes--;
  }
  return d;
}

/**
 * Fecha límite de liquidación comprometida para un importe.
 *
 * Es la que se persiste junto a la operación y contra la que se mide el cumplimiento
 * del plazo informado.
 *
 * @param {{ amountBOB:number, desde?:Date }} p
 * @returns {{ tramo:object, venceAt:Date }|null}
 */
export function plazoLiquidacion({ amountBOB, desde = new Date() }) {
  const tramo = resolveTramo(amountBOB);
  if (!tramo) return null;

  // Día hábil 0 = fin del mismo día hábil. Si el importe entra un sábado o domingo,
  // el "mismo día hábil" es el lunes: no se compromete un plazo que cae en día no hábil.
  const base = (desde.getDay() === 0 || desde.getDay() === 6)
    ? addBusinessDays(desde, 1)
    : desde;

  const venceAt = tramo.diasHabiles === 0 ? base : addBusinessDays(base, tramo.diasHabiles);
  venceAt.setHours(23, 59, 59, 999);

  return { tramo, venceAt };
}

/**
 * Forma pública para la cotización. Es lo que el consumidor ve antes de confirmar.
 *
 * No expone los bordes del tramo: al consumidor le importa el plazo de SU operación,
 * y publicar la tabla completa en cada cotización invita a fraccionar para bajar de
 * tramo, que es exactamente lo que los límites agregados existen para impedir.
 */
export function tramoPublico(amountBOB, desde = new Date()) {
  const r = plazoLiquidacion({ amountBOB, desde });
  if (!r) return null;
  return {
    tramo:                 r.tramo.id,
    tramoNombre:           r.tramo.nombre,
    plazoLiquidacion:      r.tramo.plazoTexto,
    plazoDiasHabiles:      r.tramo.diasHabiles,
    plazoLiquidacionHasta: r.venceAt.toISOString(),
  };
}

export default { ECP_TRAMOS, ECP_TRAMO_IDS, resolveTramo, addBusinessDays, plazoLiquidacion, tramoPublico };
