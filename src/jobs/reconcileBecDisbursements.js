/**
 * reconcileBecDisbursements.js
 *
 * Red de seguridad de la dispersión bancaria BANECO (§9 Planillas). El camino feliz
 * es el webhook notifyStatus (POST /api/v1/ipn/bec-disbursement → settleDispatchedWithdrawal).
 * Este job cubre el IPN perdido: un retiro queda en 'dispatched' (dinero ya ordenado
 * al banco, saldo reservado) y nunca llega la confirmación.
 *
 * BANECO no documenta un GET de estado de planilla, así que NO auto-completamos un
 * movimiento de salida de dinero por inferencia (sería arriesgado). En cambio,
 * ALERTAMOS al admin sobre retiros 'dispatched' atascados para que verifique en el
 * banco y los liquide manualmente (confirm real o simulate-settle en staging). El
 * admin tiene el control sobre dinero saliente — coherente con la postura AML/ASFI.
 *
 * Frecuencia recomendada: cada 30 min. Primera corrida 5 min post-start.
 */

import WalletTransaction from '../models/WalletTransaction.js';
import { notifyAdmins, NOTIFICATIONS } from '../services/notifications.js';
import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';

// Tras cuánto tiempo en 'dispatched' sin confirmar lo consideramos atascado.
const STUCK_MS  = Number(process.env.BANK_DISBURSEMENT_STUCK_MIN ?? 60) * 60 * 1000;
const SWEEP_LIMIT = 50;

let _isRunning = false;

export async function reconcileBecDisbursements() {
  if (_isRunning) {
    logger.warn('[ReconcileDisbursement] Corrida previa aún en curso — omitiendo');
    return;
  }
  _isRunning = true;

  try {
    const cutoff = new Date(Date.now() - STUCK_MS);

    // Retiros enviados al banco hace más de STUCK_MS, aún sin confirmar, no alertados.
    const stuck = await WalletTransaction.find({
      type:      'withdrawal',
      status:    'dispatched',
      'metadata.dispatchedAt':         { $lte: cutoff },
      'metadata.disbursementAlertedAt': { $exists: false },
    }).sort({ createdAt: 1 }).limit(SWEEP_LIMIT);

    if (stuck.length === 0) {
      logger.info('[ReconcileDisbursement] Sin retiros dispersados atascados');
      return;
    }

    logger.warn(`[ReconcileDisbursement] ${stuck.length} retiro(s) dispersado(s) sin confirmación — alertando admin`);

    for (const wtx of stuck) {
      Sentry.captureMessage('BEC disbursement stuck (notifyStatus no recibido)', {
        level: 'warning',
        extra: {
          wtxId:        wtx.wtxId,
          amount:       wtx.amount,
          bankBatchId:  wtx.metadata?.bankBatchId,
          dispatchedAt: wtx.metadata?.dispatchedAt,
        },
      });

      await notifyAdmins(NOTIFICATIONS.adminDisbursementStuck?.(wtx.amount, wtx.wtxId) ?? {
        title: 'Dispersión sin confirmar',
        body:  `El retiro ${wtx.wtxId} (Bs. ${Number(wtx.amount).toFixed(2)}) fue enviado al banco pero no llegó la confirmación. Verificar en BANECO y liquidar.`,
        data:  { type: 'admin_disbursement_stuck', wtxId: wtx.wtxId },
      }).catch(() => {});

      // Marcar alertado para no spamear en cada corrida (una alerta por retiro).
      await WalletTransaction.updateOne(
        { _id: wtx._id },
        { $set: { 'metadata.disbursementAlertedAt': new Date() } },
      ).catch(() => {});
    }
  } catch (err) {
    Sentry.captureException(err, { tags: { job: 'reconcileBecDisbursements' } });
    logger.error(`[ReconcileDisbursement] Error: ${err.message}`);
  } finally {
    _isRunning = false;
  }
}

export default reconcileBecDisbursements;
