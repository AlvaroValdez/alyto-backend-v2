/**
 * reconcileHarborTransfers.js
 *
 * Recupera transacciones Harbor cuyo status quedó "atascado" por webhook
 * perdido. Consulta el status real de Harbor via API y reconcilia.
 *
 * Casos cubiertos:
 *   payout_sent (>15 min sin transition)              → poll Harbor → completed | failed
 *   payout_pending_usdc_send (>2h sin USDC send)      → alert admin
 *
 * No reintenta envíos automáticamente — solo reconcilia el status local
 * con el de Harbor (single source of truth).
 *
 * Triggers:
 *   - setInterval en server.js cada 15 min
 *   - POST /api/v1/admin/reconcile-harbor (manual desde admin)
 */

import Transaction         from '../models/Transaction.js';
import { getTransferStatus, getCustomerUuid } from '../services/owlPayService.js';
import { sendRawEmail }    from '../services/email.js';

// Edad mínima antes de reconciliar — evita race condition con webhook que
// llega normal en segundos. Si webhook no llegó en 15 min, ya hay problema.
const PAYOUT_SENT_AGE_MS        = 15 * 60 * 1000;       // 15 min
const PAYOUT_PENDING_USDC_AGE_MS = 2  * 60 * 60 * 1000; // 2 horas
const MAX_AGE_BEFORE_GIVEUP_MS   = 7  * 24 * 60 * 60 * 1000; // 7 días (auto-fail)

// Mapeo Harbor status → Alyto status
const HARBOR_TO_ALYTO_STATUS = {
  completed:                      'completed',
  source_received:                'payout_sent',    // ya lo teníamos
  pending_customer_transfer_start:'payout_sent',
  failed:                         'failed',
  expired:                        'failed',
  cancelled:                      'failed',
  refunded:                       'refunded',
};

export async function reconcileHarborTransfers() {
  if (!getCustomerUuid()) {
    console.info('[Reconcile] OWLPAY_CUSTOMER_UUID no configurado — skip');
    return { reconciled: 0, skipped: true };
  }

  const now = Date.now();
  const stats = { reconciled: 0, completed: 0, failed: 0, unchanged: 0, errors: 0, expired: 0 };

  // ── 1. payout_sent atascadas (webhook perdido) ──────────────────────────
  const stuckSent = await Transaction.find({
    status: 'payout_sent',
    'harborTransfer.transferId': { $exists: true, $ne: null },
    updatedAt: { $lt: new Date(now - PAYOUT_SENT_AGE_MS) },
  }).limit(50);

  for (const tx of stuckSent) {
    try {
      const result = await getTransferStatus(tx.harborTransfer.transferId);
      const harborStatus = result?.data?.status ?? result?.status;
      const alytoStatus  = HARBOR_TO_ALYTO_STATUS[harborStatus] ?? null;

      // Tx muy vieja sin completar → marcar failed manual review
      const ageMs = now - new Date(tx.updatedAt).getTime();
      if (ageMs > MAX_AGE_BEFORE_GIVEUP_MS && tx.status !== 'completed') {
        tx.status = 'failed';
        tx.failureReason     = `[Reconcile] Transfer abandonado tras ${Math.floor(ageMs/86400000)}d sin completar (Harbor status: ${harborStatus})`;
        tx.userFailureReason = 'No pudimos confirmar la entrega de esta transferencia. Nuestro equipo está investigando.';
        tx.failureCategory   = 'STALE_PAYOUT';
        await tx.save();
        stats.expired++;
        console.warn(`[Reconcile] ${tx.alytoTransactionId} marked failed (stale ${Math.floor(ageMs/3600000)}h)`);
        continue;
      }

      if (!alytoStatus || alytoStatus === tx.status) {
        stats.unchanged++;
        continue;
      }

      console.info(`[Reconcile] ${tx.alytoTransactionId}: ${tx.status} → ${alytoStatus} (Harbor: ${harborStatus})`);
      const previousStatus = tx.status;
      tx.status = alytoStatus;
      if (tx.harborTransfer) tx.harborTransfer.status = harborStatus;
      tx.ipnLog.push({
        provider:   'reconcile',
        eventType:  `harbor_status_reconciled_${harborStatus}`,
        status:     alytoStatus,
        rawPayload: { previousStatus, harborStatus, polledAt: new Date() },
        receivedAt: new Date(),
      });
      await tx.save();
      stats.reconciled++;
      if (alytoStatus === 'completed') stats.completed++;
      if (alytoStatus === 'failed')    stats.failed++;
    } catch (err) {
      stats.errors++;
      console.error(`[Reconcile] ${tx.alytoTransactionId} error:`, err.message);
    }
  }

  // ── 2. payout_pending_usdc_send atascadas (admin no envió USDC) ─────────
  const stuckPendingUsdc = await Transaction.find({
    status: 'payout_pending_usdc_send',
    updatedAt: { $lt: new Date(now - PAYOUT_PENDING_USDC_AGE_MS) },
  }).limit(20);

  if (stuckPendingUsdc.length > 0) {
    const ids = stuckPendingUsdc.map(t => t.alytoTransactionId);
    console.warn(`[Reconcile] ${ids.length} tx pending_usdc_send >2h — alerting admin`);
    try {
      await sendRawEmail(
        process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
        `⚠️ ${ids.length} tx Harbor pendientes envío USDC manual (>2h)`,
        `<p>Las siguientes transacciones esperan envío manual USDC desde wallet SRL Stellar:</p>` +
        `<ul>${ids.map(id => `<li>${id}</li>`).join('')}</ul>` +
        `<p>Acción: revisar admin Ledger y enviar USDC, o activar <code>OWLPAY_USDC_SEND_ENABLED=1</code> ` +
        `+ correr <code>scripts/resume-usdc-send.js --all</code>.</p>`,
      );
    } catch (e) { console.error('[Reconcile] Error email admin (pending_usdc):', e.message); }
  }

  if (stats.reconciled > 0 || stats.errors > 0 || stats.expired > 0) {
    console.info('[Reconcile] Stats:', stats);
  }
  return stats;
}
