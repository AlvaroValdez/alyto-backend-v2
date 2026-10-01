/**
 * adminAlertThrottle.js — "¿Ya avisamos esto hace poco?"
 *
 * Una sola pregunta, atómica y persistente, para que las alertas admin dejen de
 * repetirse. Nace de medir el 2026-10-01 de dónde salían los correos del día:
 *
 *   - 12 correos de "Payout bloqueado" para apenas 2 transacciones. `dispatchPayout`
 *     avisaba en cada intento, sin ninguna antirrepetición.
 *   - 10 del monitor de KYC incompleto, repitiendo el mismo listado.
 *   -  8 de AnchorAdmin pese a tener cooldown de 6 horas, porque ese cooldown vive
 *     en memoria del proceso y los tres deploys del día lo resetearon.
 *
 * Eso importa más allá del ruido: el plan de SendGrid tiene tope duro de 100
 * correos diarios por cuenta, así que las alertas repetidas consumen el cupo que
 * después le falta a un correo de usuario.
 *
 * ── Por qué en la base y no en memoria ──────────────────────────────────────
 *
 * Un `Map` de módulo es más simple, pero se borra en cada arranque. En un backend
 * que se redespliega varias veces por día, un cooldown de 6 horas que se reinicia
 * con el proceso no es un cooldown. Además, si mañana corren dos instancias, cada
 * una tendría su propia idea de qué ya avisó.
 *
 * ── Por qué atómico ─────────────────────────────────────────────────────────
 *
 * Leer-y-después-escribir deja una ventana en la que dos ejecuciones concurrentes
 * del mismo job deciden las dos que les toca avisar. Acá la decisión es una sola
 * operación: un `findOneAndUpdate` con upsert cuyo filtro exige que el último
 * envío sea más viejo que el cooldown. Si ya hay un documento fresco, el filtro
 * no matchea, el upsert choca contra el índice único de `key` y Mongo devuelve
 * un error 11000 — que es precisamente la señal de "otro llegó primero".
 */

import AdminAlertThrottle from '../models/AdminAlertThrottle.js';
import { logger } from '../utils/logger.js';

/** Margen sobre el cooldown antes de que el TTL borre el documento. */
const MARGEN_TTL_MS = 60 * 60 * 1000; // 1 h

/**
 * ¿Corresponde enviar esta alerta ahora?
 *
 * Registra el envío en el mismo acto, así que quien recibe `true` DEBE enviar:
 * no hay forma de "devolver" el permiso.
 *
 * Falla ABIERTO: si la base no responde, devuelve `true`. Perder una alerta por
 * un problema de infraestructura es peor que mandarla repetida — el que la
 * recibe puede ignorar un duplicado, pero no puede adivinar lo que no llegó.
 *
 * @param {string} key        — identifica la alerta; incluir el sujeto si aplica
 * @param {number} cooldownMs — tiempo mínimo entre dos envíos de la misma clave
 * @returns {Promise<boolean>}
 */
export async function debeAlertar(key, cooldownMs) {
  if (!key) return true;
  const ahora  = new Date();
  const umbral = new Date(ahora.getTime() - Math.max(0, cooldownMs));

  try {
    await AdminAlertThrottle.findOneAndUpdate(
      { key, lastSentAt: { $lte: umbral } },
      {
        $set:  { key, lastSentAt: ahora, expiresAt: new Date(ahora.getTime() + cooldownMs + MARGEN_TTL_MS) },
        $inc:  { enviadas: 1 },
        $setOnInsert: { suprimidas: 0 },
      },
      // No se usa el documento devuelto: solo interesa si la operación pasó o
      // chocó contra el índice único.
      { upsert: true, setDefaultsOnInsert: true },
    );
    return true;
  } catch (err) {
    // 11000 = el documento ya existe y es más nuevo que el umbral: alguien ya
    // avisó dentro del cooldown. Es el camino esperado, no una anomalía.
    if (err?.code === 11000) {
      await AdminAlertThrottle.updateOne({ key }, { $inc: { suprimidas: 1 } }).catch(() => {});
      return false;
    }
    logger.warn('[adminAlertThrottle] No se pudo consultar el cooldown, se envía igual', {
      key,
      error: err?.message,
    });
    return true;
  }
}

/**
 * Estado actual de una clave, para diagnóstico. No modifica nada.
 *
 * @param {string} key
 * @returns {Promise<{lastSentAt: Date, enviadas: number, suprimidas: number}|null>}
 */
export async function estadoAlerta(key) {
  return AdminAlertThrottle.findOne({ key })
    .select('lastSentAt enviadas suprimidas -_id')
    .lean()
    .catch(() => null);
}
