/**
 * cleanupOrphanTransactions.js
 *
 * Archiva (soft-delete) transacciones huérfanas: payin_pending con instrucciones
 * de pago expiradas y sin comprobante subido. ASFI exige conservar el historial
 * completo — nunca se eliminan físicamente.
 *
 * Criterios de huérfana:
 *   - status === 'payin_pending'
 *   - paymentInstructionsExpiresAt < now  (default: createdAt + 24h)
 *   - Sin paymentProof.data (base64 no subido)
 *   - Sin evento 'payment_proof_uploaded' en ipnLog
 *   - archivedAt es null (no archivada todavía)
 *
 * Acción: updateMany → status='failed', archivedAt=now (soft-delete para auditoría)
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
    const result = await Transaction.updateMany(
      {
        // payin_pending: payin manual que subió comprobante pero expiró sin confirmar.
        // pending_comprobante: intento manual abandonado — el usuario nunca subió el
        //   comprobante (sin él, la tx jamás avanza). Antes quedaba zombie para siempre
        //   porque el cleanup solo miraba payin_pending. El guard de paymentProof.data
        //   excluye las que sí esperan revisión del admin.
        status:                       { $in: ['payin_pending', 'pending_comprobante'] },
        paymentInstructionsExpiresAt: { $lt: new Date() },
        'paymentProof.data':          { $exists: false },
        'ipnLog.eventType':           { $ne: 'payment_proof_uploaded' },
        // Excluir transacciones bankQr: su confirmación llega del banco (webhook o
        // reconciliación), no del usuario. Las vencidas las archiva reconcileBankQrPayments
        // (barrido de expiración con cancelación del QR en el banco).
        'bankQr.qrId':                { $exists: false },
        archivedAt:                   null,
      },
      {
        $set: {
          status:        'failed',
          archivedAt:    new Date(),
          failureReason: 'Transacción abandonada — instrucciones de pago expiradas sin comprobante.',
        },
      },
    );

    const elapsed = Date.now() - startTime;

    if (result.modifiedCount > 0) {
      console.info(
        `[Cleanup] ${result.modifiedCount} transacciones huérfanas archivadas (${elapsed}ms)`
      );
    }

    return result.modifiedCount;
  } catch (err) {
    console.error('[Cleanup] Error en cleanup de huérfanas:', err.message);
    Sentry.captureException(err, { tags: { component: 'cleanupOrphanTransactions' } });
    return -1;
  }
}
