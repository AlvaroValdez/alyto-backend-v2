/**
 * reconcileHarborTransfers.js
 *
 * Recupera transacciones Harbor cuyo status quedó "atascado" por webhook
 * perdido. Consulta el status real de Harbor via API y reconcilia.
 *
 * Casos cubiertos:
 *   payout_sent (>15 min sin transition)              → poll Harbor → completed | failed
 *   payout_pending_usdc_send (>2h sin USDC send)      → alert admin
 *   failed + failureRetryable=true + TRANSIENT_ERROR  → reintento automático (hasta 3x, backoff 5 min)
 *
 * Triggers:
 *   - setInterval en server.js cada 15 min
 *   - POST /api/v1/admin/reconcile-harbor (manual desde admin)
 */

import Transaction         from '../models/Transaction.js';
import TransactionConfig  from '../models/TransactionConfig.js';
import { getTransferStatus, getCustomerUuid } from '../services/owlPayService.js';
import { sendRawEmail }    from '../services/email.js';
import { tryOwlPayV2, generateComprobanteOnCompletion } from '../controllers/ipnController.js';
import { registerAuditTrail } from '../services/stellarService.js';
import { mapHarborError } from '../utils/harborErrorMapper.js';

// Edad mínima antes de reconciliar — evita race condition con webhook que
// llega normal en segundos. Si webhook no llegó en 15 min, ya hay problema.
const PAYOUT_SENT_AGE_MS         = 15 * 60 * 1000;       // 15 min
const PAYOUT_PENDING_USDC_AGE_MS = 2  * 60 * 60 * 1000;  // 2 horas
const MAX_AGE_BEFORE_GIVEUP_MS   = 7  * 24 * 60 * 60 * 1000; // 7 días (auto-fail)

// Parámetros de reintento automático para TRANSIENT_ERROR
const MAX_RECONCILE_RETRIES = 3;
const RETRY_BACKOFF_MS      = 5 * 60 * 1000; // 5 min mínimo entre reintentos

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

// Guard de overlap: dos corridas solapadas podían leer la misma tx failed y
// ambas crear transfer Harbor + enviar USDC dos veces (audit 2026-06-11).
let _isRunning = false;

export async function reconcileHarborTransfers() {
  if (_isRunning) {
    console.warn('[Reconcile] Corrida anterior aún en curso — skip');
    return { reconciled: 0, skipped: true };
  }
  if (!getCustomerUuid()) {
    console.info('[Reconcile] OWLPAY_CUSTOMER_UUID no configurado — skip');
    return { reconciled: 0, skipped: true };
  }
  _isRunning = true;
  try {
    return await _reconcileHarborTransfers();
  } finally {
    _isRunning = false;
  }
}

async function _reconcileHarborTransfers() {
  const now = Date.now();
  const stats = { reconciled: 0, completed: 0, failed: 0, unchanged: 0, errors: 0, expired: 0, unknown: 0, retried: 0, retriedFailed: 0, retriedExhausted: 0 };

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

      if (!alytoStatus) {
        // Harbor devolvió un status desconocido — alertar para revisión manual
        stats.unknown++;
        console.warn(`[Reconcile] Status Harbor desconocido: "${harborStatus}" para ${tx.alytoTransactionId} — sin mapeo Alyto`);
        tx.ipnLog.push({
          provider:   'reconcile',
          eventType:  'harbor_status_unknown',
          status:     tx.status,
          rawPayload: { harborStatus, polledAt: new Date() },
          receivedAt: new Date(),
        });
        await tx.save().catch(() => {});
        continue;
      }

      if (alytoStatus === tx.status) {
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

      // Al completar vía reconcile (webhook perdido/rechazado) hay que replicar el
      // post-proceso del webhook handleOwlPayIPN: audit trail Stellar + comprobante.
      // Sin esto, las tx completadas por el poll quedaban SIN registro on-chain ni PDF.
      if (alytoStatus === 'completed') {
        try {
          const stellarTxId = await registerAuditTrail(tx);
          if (stellarTxId) {
            tx.stellarTxId = stellarTxId;
            tx.ipnLog.push({
              provider:   'stellar',
              eventType:  'stellar_audit_registered',
              status:     'completed',
              rawPayload: { stellarTxId, network: process.env.STELLAR_NETWORK ?? 'testnet', source: 'reconcile' },
              receivedAt: new Date(),
            });
          }
        } catch (auditErr) {
          console.error(`[Reconcile] audit trail falló ${tx.alytoTransactionId}:`, auditErr.message);
        }
      }

      await tx.save();
      stats.reconciled++;
      if (alytoStatus === 'completed') {
        stats.completed++;
        // PDF comprobante — fire-and-forget (idempotente, no bloquea el ciclo).
        generateComprobanteOnCompletion(tx).catch(() => {});
      }
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

  // ── 3. failed + failureRetryable: true (Harbor TRANSIENT_ERROR) ─────────────
  // Transacciones cuyo POST /v2/transfers agotó el timeout pero nunca obtuvieron
  // un transferId — el job las reintenta automáticamente hasta MAX_RECONCILE_RETRIES.
  const stuckFailed = await Transaction.find({
    status:           'failed',
    failureRetryable: true,
    failureCategory:  'TRANSIENT_ERROR',
    'harborTransfer.transferId': { $in: [null, undefined] },
    reconcileRetryCount: { $lt: MAX_RECONCILE_RETRIES },
    updatedAt: { $lt: new Date(now - RETRY_BACKOFF_MS) },
  }).limit(10);

  const exhaustedIds = [];

  for (const tx of stuckFailed) {
    const attempt = (tx.reconcileRetryCount ?? 0) + 1;
    try {
      const corridor = await TransactionConfig
        .findOne({ corridorId: tx.corridorCode })
        .lean();

      if (!corridor) {
        console.warn(`[Reconcile] Corredor "${tx.corridorCode}" no encontrado para ${tx.alytoTransactionId} — skip retry`);
        continue;
      }

      const netAmountUSD = tx.digitalAssetAmount;
      if (!netAmountUSD || netAmountUSD <= 0) {
        console.warn(`[Reconcile] digitalAssetAmount inválido (${netAmountUSD}) para ${tx.alytoTransactionId} — skip retry`);
        continue;
      }

      // Registrar el intento antes de ejecutar — evita loop en caso de crash
      tx.reconcileRetryCount = attempt;
      tx.ipnLog.push({
        provider:   'reconcile',
        eventType:  'reconcile_retry_attempt',
        status:     tx.status,
        rawPayload: { attempt, maxAttempts: MAX_RECONCILE_RETRIES, at: new Date() },
        receivedAt: new Date(),
      });
      await tx.save();

      console.info(`[Reconcile] Reintentando ${tx.alytoTransactionId} — intento ${attempt}/${MAX_RECONCILE_RETRIES}`);

      await tryOwlPayV2(tx, corridor, netAmountUSD);

      stats.retried++;
      console.info(`[Reconcile] ${tx.alytoTransactionId} reintentado OK → ${tx.status}`);
    } catch (err) {
      stats.retriedFailed++;
      const mapped = mapHarborError(err);

      tx.status            = 'failed';
      tx.failureReason     = mapped.adminMessage;
      tx.failureCategory   = mapped.category;
      tx.failureRetryable  = attempt < MAX_RECONCILE_RETRIES && mapped.retryable;
      tx.ipnLog.push({
        provider:   'reconcile',
        eventType:  'reconcile_retry_failed',
        status:     'failed',
        rawPayload: { attempt, category: mapped.category, error: err.message },
        receivedAt: new Date(),
      });
      await tx.save().catch(() => {});

      if (!tx.failureRetryable) {
        exhaustedIds.push(tx.alytoTransactionId);
        stats.retriedExhausted++;
      }

      console.error(`[Reconcile] Reintento fallido ${tx.alytoTransactionId} (intento ${attempt}):`, err.message);
    }
  }

  if (exhaustedIds.length > 0) {
    console.warn(`[Reconcile] ${exhaustedIds.length} tx agotaron reintentos automáticos — requieren revisión manual`);
    try {
      await sendRawEmail(
        process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
        `⚠️ ${exhaustedIds.length} tx Harbor agotaron reintentos automáticos`,
        `<p>Las siguientes transacciones fallaron ${MAX_RECONCILE_RETRIES} reintentos automáticos ` +
        `y requieren revisión manual en el Ledger:</p>` +
        `<ul>${exhaustedIds.map(id => `<li>${id}</li>`).join('')}</ul>` +
        `<p>Revisar el corredor en el admin panel y contactar a OwlPay si el problema persiste.</p>`,
      );
    } catch (e) { console.error('[Reconcile] Error email admin (exhausted):', e.message); }
  }

  if (stats.reconciled > 0 || stats.errors > 0 || stats.expired > 0 || stats.unknown > 0 || stats.retried > 0 || stats.retriedFailed > 0) {
    console.info('[Reconcile] Stats:', stats);
  }
  return stats;
}
