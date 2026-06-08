/**
 * reconcileVitaTransfers.js
 *
 * Recupera transacciones Vita cuyo status quedó "atascado" en payout_sent
 * por IPN perdido (server down, timeout, reinicio).
 *
 * Estrategia:
 *   1. Busca tx en payout_sent + provider vitaWallet + edad > 15 min
 *   2. Por cada tx: intenta GET /transactions/:vitaId (best-effort, Vita es event-driven)
 *   3. Si Vita confirma completed → finaliza (audit trail + comprobante + notif)
 *   4. Si Vita confirma denied   → marca failed + alerta admin
 *   5. Si Vita no tiene el ID o falla   → alerta admin con digest para revisión manual
 *   6. Después de 7 días sin resolución → auto-fail + alerta urgente
 *
 * Triggers:
 *   - setInterval en server.js cada 15 min
 *   - POST /api/v1/admin/reconcile-vita (manual desde admin)
 */

import Transaction    from '../models/Transaction.js';
import User           from '../models/User.js';
import { getVitaTransaction }             from '../services/vitaWalletService.js';
import { registerAuditTrail }             from '../services/stellarService.js';
import {
  generateComprobanteOnCompletion,
  notifyAdminManualPayout,
}                                         from '../controllers/ipnController.js';
import { notify, NOTIFICATIONS }         from '../services/notifications.js';
import { sendEmail, EMAILS }             from '../services/email.js';
import { sendRawEmail }                  from '../services/email.js';
import { logger }                        from '../utils/logger.js';

const PAYOUT_SENT_AGE_MS       = 15 * 60 * 1000;          // 15 min antes de reconciliar
const MAX_AGE_BEFORE_GIVEUP_MS = 7 * 24 * 60 * 60 * 1000; // 7 días → auto-fail
const ALERT_THRESHOLD_MS       = 2 * 60 * 60 * 1000;      // 2h → alerta admin si sin resolver

// Mapeo estados Vita → acción
const VITA_COMPLETED_STATUSES = new Set(['completed']);
const VITA_FAILED_STATUSES    = new Set(['denied', 'rejected', 'expired', 'cancelled']);

/**
 * Finaliza una transacción Vita cuyo IPN llegó tarde (vía reconcile).
 * Replica el bloque "vitaStatus === 'completed'" de ipnController.handleVitaIPN.
 */
async function finalizeVitaCompleted(transaction) {
  transaction.status      = 'completed';
  transaction.completedAt = new Date();
  transaction.ipnLog = transaction.ipnLog ?? [];
  transaction.ipnLog.push({
    provider:   'vitaWallet',
    eventType:  'payout_completed_reconcile',
    status:     'completed',
    rawPayload: { source: 'reconcileVitaTransfers', reconciledAt: new Date() },
    receivedAt: new Date(),
  });
  await transaction.save();

  // Audit trail Stellar (best-effort)
  try {
    const stellarTxId = await registerAuditTrail(transaction);
    if (stellarTxId) {
      transaction.stellarTxId = stellarTxId;
      transaction.ipnLog.push({
        provider:   'stellar',
        eventType:  'stellar_audit_registered',
        status:     'completed',
        rawPayload: {
          stellarTxId,
          network:     process.env.STELLAR_NETWORK ?? 'testnet',
          explorerUrl: `https://stellar.expert/explorer/${
            process.env.STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet'
          }/tx/${stellarTxId}`,
        },
        receivedAt: new Date(),
      });
      await transaction.save().catch(() => {});
    }
  } catch { /* best-effort */ }

  // Comprobante / factura — fire-and-forget
  generateComprobanteOnCompletion(transaction).catch(() => {});

  // Push notification
  notify(
    transaction.userId,
    NOTIFICATIONS.paymentCompleted(
      transaction.originalAmount,
      transaction.originCurrency,
      transaction.destinationAmount,
      transaction.destinationCurrency,
    ),
  ).catch(() => {});

  // Email al usuario
  try {
    const user = await User.findById(transaction.userId).lean();
    if (user?.email) {
      await sendEmail(...EMAILS.paymentCompleted(user, transaction));
    }
  } catch { /* best-effort */ }

  logger.info('[ReconcileVita] ✅ Tx completada vía reconcile', {
    transactionId: transaction.alytoTransactionId,
    payoutReference: transaction.payoutReference,
  });
}

/**
 * Marca una transacción Vita como fallida (payout denegado).
 */
async function finalizeVitaFailed(transaction, reason) {
  transaction.status        = 'failed';
  transaction.failureReason = reason;
  transaction.ipnLog = transaction.ipnLog ?? [];
  transaction.ipnLog.push({
    provider:   'vitaWallet',
    eventType:  'payout_denied_reconcile',
    status:     'failed',
    rawPayload: { source: 'reconcileVitaTransfers', reason },
    receivedAt: new Date(),
  });
  await transaction.save();

  notifyAdminManualPayout(transaction).catch(() => {});

  notify(
    transaction.userId,
    NOTIFICATIONS.paymentFailed(transaction.originalAmount, transaction.originCurrency),
  ).catch(() => {});

  logger.warn('[ReconcileVita] ❌ Tx marcada failed vía reconcile', {
    transactionId: transaction.alytoTransactionId,
    reason,
  });
}

/**
 * Envía email de alerta al admin con digest de tx sin resolver.
 */
async function alertAdminUnresolved(transactions) {
  if (!transactions.length) return;
  const adminEmail = process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  const rows = transactions.map(tx => {
    const ageMin = Math.round((Date.now() - new Date(tx.updatedAt).getTime()) / 60_000);
    return `• ${tx.alytoTransactionId} — ${tx.destinationCountry} — ${tx.originalAmount} ${tx.originCurrency} — ${ageMin} min sin resolver (vitaId: ${tx.payoutReference ?? 'n/a'})`;
  }).join('\n');

  const body = `
[Alyto Reconcile] ${transactions.length} transacción(es) Vita en payout_sent sin IPN

Estas transacciones llevan más de ${Math.round(ALERT_THRESHOLD_MS / 60_000)} minutos sin confirmación.
Vita es event-driven; el IPN puede llegar tarde. Verificar en panel Vita Business si ya se procesaron
y confirmar manualmente desde el Ledger si es necesario.

${rows}

Alyto Backend — ${new Date().toISOString()}
`.trim();

  await sendRawEmail({
    to:      adminEmail,
    subject: `[Alyto] ⚠️ ${transactions.length} tx Vita sin resolver (reconcile)`,
    text:    body,
  }).catch(() => {});
}

/**
 * Job principal.
 * @returns {Promise<{checked: number, completed: number, failed: number, unresolved: number, autoFailed: number}>}
 */
export async function reconcileVitaTransfers() {
  const stats = { checked: 0, completed: 0, failed: 0, unresolved: 0, autoFailed: 0 };
  const now   = new Date();

  try {
    const minAge = new Date(now.getTime() - PAYOUT_SENT_AGE_MS);

    const stuckTxs = await Transaction.find({
      status:        'payout_sent',
      providersUsed: 'payout:vitaWallet',
      updatedAt:     { $lt: minAge },
    }).limit(50).lean(false); // lean(false) para poder mutar y guardar

    if (!stuckTxs.length) return stats;

    logger.info(`[ReconcileVita] ${stuckTxs.length} tx payout_sent pendientes de reconciliar`);
    stats.checked = stuckTxs.length;

    const unresolved = [];

    for (const tx of stuckTxs) {
      const ageMs = now.getTime() - new Date(tx.updatedAt).getTime();

      // Auto-fail si supera el umbral máximo
      if (ageMs > MAX_AGE_BEFORE_GIVEUP_MS) {
        await finalizeVitaFailed(tx, 'Auto-fail por reconcile: sin IPN tras 7 días. Revisar con Vita manualmente.');
        stats.autoFailed++;
        continue;
      }

      // Sin payoutReference — no se puede consultar a Vita
      if (!tx.payoutReference) {
        if (ageMs > ALERT_THRESHOLD_MS) unresolved.push(tx);
        continue;
      }

      let vitaData;
      try {
        const resp = await getVitaTransaction(tx.payoutReference);
        // Vita puede envolver la tx en data.transaction o data.withdrawal o directamente
        vitaData = resp?.data?.transaction ?? resp?.data?.withdrawal ?? resp?.data ?? resp;
      } catch (err) {
        // 404 = Vita no tiene ese ID aún (IPN puede llegar después), otro error = API problema
        const isNotFound = err?.response?.status === 404 || err?.status === 404;
        if (!isNotFound) {
          logger.warn('[ReconcileVita] Error consultando Vita', {
            transactionId: tx.alytoTransactionId,
            error: err.message,
          });
        }
        if (ageMs > ALERT_THRESHOLD_MS) unresolved.push(tx);
        continue;
      }

      const vitaStatus = vitaData?.status?.toLowerCase?.() ?? '';

      if (VITA_COMPLETED_STATUSES.has(vitaStatus)) {
        await finalizeVitaCompleted(tx);
        stats.completed++;
      } else if (VITA_FAILED_STATUSES.has(vitaStatus)) {
        await finalizeVitaFailed(tx, `Payout denegado por Vita (reconcile): status=${vitaStatus}`);
        stats.failed++;
      } else {
        // pending / processing — Vita aún trabajando, OK
        if (ageMs > ALERT_THRESHOLD_MS) unresolved.push(tx);
      }
    }

    // Alerta admin con digest de no resueltas
    if (unresolved.length) {
      stats.unresolved = unresolved.length;
      await alertAdminUnresolved(unresolved);
    }

    if (stats.completed || stats.failed || stats.autoFailed) {
      logger.info('[ReconcileVita] Resultado', stats);
    }
  } catch (err) {
    logger.error('[ReconcileVita] Error inesperado en el job', { error: err.message });
  }

  return stats;
}
