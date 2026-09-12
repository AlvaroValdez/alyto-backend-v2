/**
 * resealAuditTrails.js — Red de seguridad del sello on-chain.
 *
 * El sello de existencia en Stellar (registerAuditTrail) es best-effort y no bloquea el
 * pago (regla 13). Con sólo eso, una operación completada durante un fallo de Horizon
 * quedaba SIN sello para siempre — y la respuesta a ASFI declara que "cada operación
 * completada" queda sellada. Este job cierra ese hueco: busca operaciones completadas
 * sin `stellarTxId` y reintenta el sello, con cadencia y cooldown, hasta lograrlo.
 *
 * Garantía: ninguna operación completada queda silenciosamente sin sello. Si tras el
 * presupuesto de reintentos sigue sin sellarse, se registra en ERROR (no en silencio),
 * de modo que un supervisor pueda verlo.
 *
 * Acotado a propósito:
 *   - `maxAttempts`  presupuesto de intentos por tx a lo largo de las corridas —
 *                    evita martillar un fallo permanente (config, falta de XLM).
 *   - `cooldownMs`   separación mínima entre intentos de la MISMA tx.
 *   - `sinceMs`      ventana temporal — no re-sella el histórico antiguo (era testnet).
 *   - `batch`        techo de tx por corrida.
 */

import Transaction from '../models/Transaction.js';
import { registerAuditTrail } from '../services/stellarService.js';
import { logger } from '../utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Filtro de las operaciones a re-sellar. PURO, para probarlo sin base de datos.
 *
 * @param {{ now:Date, maxAttempts:number, cooldownMs:number, sinceMs:number }} p
 */
export function buildResealFilter({ now, maxAttempts, cooldownMs, sinceMs }) {
  const cooldownCutoff = new Date(now.getTime() - cooldownMs);
  const since          = new Date(now.getTime() - sinceMs);
  return {
    status:      'completed',
    stellarTxId: { $in: [null, ''] },   // $in:[null] cubre también el campo ausente
    createdAt:   { $gte: since },
    $and: [
      // Aún dentro del presupuesto de intentos (o sin intentos previos registrados).
      { $or: [
        { stellarAuditAttempts: { $exists: false } },
        { stellarAuditAttempts: { $lt: maxAttempts } },
      ] },
      // Fuera del cooldown desde el último intento (o sin intento previo).
      { $or: [
        { stellarAuditLastAttemptAt: { $exists: false } },
        { stellarAuditLastAttemptAt: null },
        { stellarAuditLastAttemptAt: { $lte: cooldownCutoff } },
      ] },
    ],
  };
}

/**
 * Corre una pasada de re-sellado.
 * @returns {Promise<{processed:number, sealed:number, stillPending:number, exhausted:number}>}
 */
export async function resealAuditTrails() {
  const now         = new Date();
  const maxAttempts = envInt('STELLAR_AUDIT_RESEAL_MAX_ATTEMPTS', 10);
  const cooldownMs  = envInt('STELLAR_AUDIT_RESEAL_COOLDOWN_MS', 15 * 60 * 1000);
  const sinceMs     = envInt('STELLAR_AUDIT_RESEAL_SINCE_MS', 90 * DAY_MS);
  const batchSize   = envInt('STELLAR_AUDIT_RESEAL_BATCH', 50);

  const filter = buildResealFilter({ now, maxAttempts, cooldownMs, sinceMs });
  const batch  = await Transaction.find(filter).sort({ createdAt: 1 }).limit(batchSize);

  let sealed = 0, stillPending = 0, exhausted = 0;

  for (const tx of batch) {
    tx.stellarAuditAttempts      = (tx.stellarAuditAttempts ?? 0) + 1;
    tx.stellarAuditLastAttemptAt = new Date();

    let hash = null;
    try {
      hash = await registerAuditTrail(tx);
    } catch (err) {
      // registerAuditTrail no debería lanzar (traga sus errores), pero por si acaso.
      tx.stellarAuditLastError = err.message;
    }

    if (hash) {
      tx.stellarTxId           = hash;
      tx.stellarAuditLastError = undefined;
      if (Array.isArray(tx.ipnLog)) {
        tx.ipnLog.push({
          provider:   'stellar',
          eventType:  'stellar_audit_registered',
          status:     'completed',
          rawPayload: { stellarTxId: hash, network: process.env.STELLAR_NETWORK ?? 'testnet', source: 'reseal' },
          receivedAt: new Date(),
        });
      }
      sealed++;
    } else {
      tx.stellarAuditLastError = tx.stellarAuditLastError || 'registerAuditTrail devolvió null';
      stillPending++;
      if (tx.stellarAuditAttempts >= maxAttempts) {
        exhausted++;
        // No en silencio: una operación completada sin sello tras agotar el presupuesto
        // de reintentos es un hecho que un supervisor debe poder ver.
        logger.error('[reseal] Operación completada sin sello on-chain tras agotar reintentos', {
          alytoTransactionId: tx.alytoTransactionId,
          attempts:           tx.stellarAuditAttempts,
          lastError:          tx.stellarAuditLastError,
        });
      }
    }

    await tx.save();
  }

  logger.info('[reseal] Re-sellado on-chain', {
    candidates: batch.length, sealed, stillPending, exhausted,
  });

  return { processed: batch.length, sealed, stillPending, exhausted };
}

export default resealAuditTrails;
