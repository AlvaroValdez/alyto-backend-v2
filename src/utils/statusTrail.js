/**
 * statusTrail.js — Captura de la sucesión de estados de una operación.
 *
 * Antes se podía establecer cuándo se completó cada etapa (`paymentLegs.completedAt`)
 * y cuándo llegó cada aviso de proveedor (`ipnLog.receivedAt`), pero NO cuándo el
 * campo `status` pasó de un valor a otro ni por qué: `updatedAt` se sobrescribe en
 * cada guardado. Reconstruir el recorrido exigía cruzar dos fuentes y suponer.
 *
 * Cierra la limitación 1 del apartado 7.10 del informe técnico (Art. 2° inc. d
 * Sec. 4 — registros de actividades).
 *
 * La lógica vive acá y no dentro del hook para poder probarla sin base de datos ni
 * ciclo de vida de Mongoose — mismo criterio que `evaluateEcpLimits` o
 * `computeSolvency`, que son puras por la misma razón.
 */

/**
 * Decide qué asiento corresponde agregar, si corresponde alguno.
 *
 * @param {object} p
 * @param {boolean} p.isNew          documento recién creado
 * @param {string}  p.prevStatus     estado antes de esta mutación
 * @param {string}  p.nextStatus     estado después
 * @param {string}  [p.reason]       motivo, si el llamador lo consignó
 * @param {string}  [p.category]     categoría de fallo, si la hay
 * @param {Date}    [p.now]
 * @returns {{from:string|null, to:string, at:Date, reason:string, category:string|null}|null}
 *          `null` cuando no hay transición que registrar.
 */
export function buildStatusEntry({
  isNew, prevStatus, nextStatus, reason = '', category = null, now = new Date(),
}) {
  if (isNew) {
    return { from: null, to: nextStatus, at: now,
             reason: 'Creación de la operación', category: null };
  }
  // Sin cambio efectivo no se asienta nada: un guardado que toca otros campos no
  // debe inflar la sucesión con repeticiones del mismo estado.
  if (!nextStatus || prevStatus === nextStatus) return null;

  return {
    from:     prevStatus ?? null,
    to:       nextStatus,
    at:       now,
    // El motivo se captura JUNTO a la transición: `statusReason` lo sobrescribe el
    // cambio siguiente, así que dejarlo sólo en el documento equivale a perderlo.
    reason:   reason || '',
    category: category ?? null,
  };
}

export default { buildStatusEntry };
