/**
 * cleanupOrphanTransactions.js
 *
 * Elimina transacciones huérfanas: payin_pending con instrucciones de pago
 * expiradas y sin comprobante subido. Estas transacciones no se completarán
 * nunca — el usuario abandonó antes de transferir.
 *
 * Criterios de huérfana:
 *   - status === 'payin_pending'
 *   - paymentInstructionsExpiresAt < now  (default: createdAt + 24h)
 *   - Sin paymentProof.data (base64 no subido)
 *   - Sin evento 'payment_proof_uploaded' en ipnLog
 *
 * Cómo se programa:
 *   - Al arrancar el servidor (run inmediato)
 *   - Cada hora via setInterval en server.js
 *   - Manualmente via POST /api/v1/admin/cleanup-orphans
 */

import Transaction from '../models/Transaction.js';
import * as Sentry from '@sentry/node';

export async function cleanupOrphanTransactions() {
  const startTime = Date.now();

  try {
    const result = await Transaction.deleteMany({
      status:                       'payin_pending',
      paymentInstructionsExpiresAt: { $lt: new Date() },
      'paymentProof.data':          { $exists: false },
      'ipnLog.eventType':           { $ne: 'payment_proof_uploaded' },
    });

    const elapsed = Date.now() - startTime;

    if (result.deletedCount > 0) {
      console.info(
        `[Cleanup] ${result.deletedCount} transacciones huérfanas eliminadas (${elapsed}ms)`
      );
    }

    return result.deletedCount;
  } catch (err) {
    console.error('[Cleanup] Error en cleanup de huérfanas:', err.message);
    Sentry.captureException(err, { tags: { component: 'cleanupOrphanTransactions' } });
    return -1;
  }
}
