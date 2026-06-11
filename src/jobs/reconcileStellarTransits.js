/**
 * reconcileStellarTransits.js — Reconciliación de tránsitos Stellar atascados
 *
 * Espejo de reconcileHarborTransfers para el leg Stellar. Cubre tres casos:
 *
 *   CASO 1 — payin_completed sin stellarTxId (>5 min)
 *     Síntoma: executeWeb3Transit fue fire-and-forget y falló silenciosamente,
 *     o el webhook Fintoc llegó pero el job no arrancó.
 *     Acción: reintentar executeWeb3Transit (hasta MAX_RETRIES).
 *
 *   CASO 2 — in_transit con stellarTxId (>2h sin avanzar)
 *     Síntoma: tránsito Stellar confirmado pero el payout downstream nunca arrancó.
 *     Generalmente indica que dispatchPayout no fue invocado post-tránsito.
 *     Acción: alert admin + log Sentry (requiere revisión manual del flujo).
 *
 *   CASO 3 — in_transit (>7 días sin avanzar)
 *     Síntoma: tx abandonada. No tiene sentido seguir esperando.
 *     Acción: marcar failed automáticamente.
 *
 * Frecuencia: cada 15 min (mismo intervalo que reconcileHarborTransfers).
 * Se registra en jobRegistry para poder dispararse on-demand vía EventBridge.
 *
 * Alcance: solo transacciones con legalEntity = SpA (flujo Fintoc→Stellar).
 * SRL Bolivia no usa executeWeb3Transit — el tránsito es manual admin.
 */

import * as Sentry        from '@sentry/node';
import Transaction        from '../models/Transaction.js';
import { sendRawEmail }   from '../services/email.js';
import { executeWeb3Transit } from '../services/stellarService.js';

const PAYIN_COMPLETED_AGE_MS   = 5  * 60 * 1000;        // 5 min → debería haber corrido Web3Transit
const IN_TRANSIT_ALERT_AGE_MS  = 2  * 60 * 60 * 1000;   // 2h  → alerta admin
const IN_TRANSIT_GIVEUP_AGE_MS = 7  * 24 * 60 * 60 * 1000; // 7d → auto-fail
const MAX_WEB3_RETRIES         = 3;

// Guard de overlap: evita que dos corridas solapadas reintenten el mismo
// transit Stellar en paralelo (audit 2026-06-11).
let _isRunning = false;

export async function reconcileStellarTransits() {
  if (_isRunning) {
    console.warn('[ReconcileStellar] Corrida anterior aún en curso — skip');
    return { retried: 0, skipped: true };
  }
  _isRunning = true;
  try {
    return await _reconcileStellarTransits();
  } finally {
    _isRunning = false;
  }
}

async function _reconcileStellarTransits() {
  const now   = Date.now();
  const stats = {
    retried: 0, retriedOk: 0, retriedFailed: 0, retriedExhausted: 0,
    alerted: 0, expired: 0,   errors: 0,
  };

  // ── CASO 1: payin_completed sin stellarTxId (>5 min) ─────────────────────
  // Solo SpA: SRL Bolivia no usa executeWeb3Transit (flujo manual admin).
  const stuckPayinCompleted = await Transaction.find({
    status:       'payin_completed',
    legalEntity:  'SpA',
    stellarTxId:  { $in: [null, undefined, ''] },
    updatedAt:    { $lt: new Date(now - PAYIN_COMPLETED_AGE_MS) },
  }).limit(20);

  for (const tx of stuckPayinCompleted) {
    const retryCount = tx.stellarRetryCount ?? 0;

    if (retryCount >= MAX_WEB3_RETRIES) {
      // Agotó reintentos automáticos — marcar failed para revisión manual
      if (tx.status !== 'failed') {
        tx.status          = 'failed';
        tx.failureReason   = `[Reconcile Stellar] executeWeb3Transit falló ${MAX_WEB3_RETRIES} veces. Revisión manual.`;
        tx.failureCategory = 'STELLAR_TRANSIT_EXHAUSTED';
        tx.ipnLog.push({
          provider:   'reconcile-stellar',
          eventType:  'web3transit_retries_exhausted',
          status:     'failed',
          rawPayload: { retryCount, at: new Date() },
          receivedAt: new Date(),
        });
        await tx.save().catch(() => {});
        stats.retriedExhausted++;
        console.warn(`[Reconcile Stellar] ${tx.alytoTransactionId}: agotó ${MAX_WEB3_RETRIES} reintentos → failed`);

        Sentry.captureMessage(`[Reconcile Stellar] Web3Transit agotó reintentos: ${tx.alytoTransactionId}`, {
          level: 'error',
          tags:  { job: 'reconcileStellarTransits', txId: tx.alytoTransactionId },
          extra: { retryCount, txId: tx.alytoTransactionId, userId: tx.userId?.toString() },
        });
      }
      stats.errors++;
      continue;
    }

    const attempt = retryCount + 1;
    console.info(`[Reconcile Stellar] Reintentando Web3Transit para ${tx.alytoTransactionId} (intento ${attempt}/${MAX_WEB3_RETRIES})`);

    // Incrementar contador antes de ejecutar — evita loop si hay crash
    tx.stellarRetryCount = attempt;
    tx.ipnLog.push({
      provider:   'reconcile-stellar',
      eventType:  'web3transit_retry_attempt',
      status:     tx.status,
      rawPayload: { attempt, maxAttempts: MAX_WEB3_RETRIES, at: new Date() },
      receivedAt: new Date(),
    });
    await tx.save().catch(() => {});

    try {
      await executeWeb3Transit(tx._id);
      stats.retriedOk++;
      stats.retried++;
      console.info(`[Reconcile Stellar] ${tx.alytoTransactionId}: Web3Transit OK en intento ${attempt}`);
    } catch (err) {
      stats.retriedFailed++;
      stats.retried++;
      console.error(`[Reconcile Stellar] ${tx.alytoTransactionId}: Web3Transit falló (intento ${attempt}):`, err.message);
      Sentry.captureException(err, {
        tags:  { job: 'reconcileStellarTransits', txId: tx.alytoTransactionId },
        extra: { attempt, txId: tx.alytoTransactionId },
      });
    }
  }

  // ── CASO 2: in_transit >2h sin avanzar — alert admin ─────────────────────
  const stuckInTransit = await Transaction.find({
    status:      'in_transit',
    updatedAt:   { $lt: new Date(now - IN_TRANSIT_ALERT_AGE_MS), $gt: new Date(now - IN_TRANSIT_GIVEUP_AGE_MS) },
  }).select('_id alytoTransactionId userId legalEntity stellarTxId updatedAt createdAt corridorCode').limit(20);

  if (stuckInTransit.length > 0) {
    const ids = stuckInTransit.map((t) => t.alytoTransactionId);
    console.warn(`[Reconcile Stellar] ${ids.length} tx in_transit >2h sin avanzar:`, ids);

    Sentry.captureMessage(`[Reconcile Stellar] ${ids.length} transacciones atascadas en in_transit >2h`, {
      level: 'warning',
      tags:  { job: 'reconcileStellarTransits' },
      extra: { ids },
    });

    stats.alerted += stuckInTransit.length;

    // Email admin consolidado (solo si hay nuevas tx en este estado)
    try {
      const rows = stuckInTransit.map((t) => {
        const ageH = ((now - new Date(t.updatedAt).getTime()) / 3_600_000).toFixed(1);
        return `<li><code>${t.alytoTransactionId}</code> — ${t.corridorCode ?? 'N/A'} — ` +
               `${ageH}h en in_transit — ` +
               `Stellar: ${t.stellarTxId ? `<a href="https://stellar.expert/explorer/public/tx/${t.stellarTxId}">${t.stellarTxId.slice(0, 16)}…</a>` : 'sin txId'}</li>`;
      }).join('');

      await sendRawEmail(
        process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app',
        `⚠️ ${stuckInTransit.length} tx Stellar atascadas en in_transit (>2h)`,
        `<h3>Transacciones en_transit sin avanzar</h3>
<p>Estas transacciones llevan más de 2 horas en estado <code>in_transit</code> sin pasar a payout.
Posibles causas: dispatchPayout no fue invocado, error silencioso post-tránsito.</p>
<ul>${rows}</ul>
<p><strong>Acción:</strong> Revisar en el Ledger admin. Si el tránsito Stellar está confirmado,
puede ser necesario disparar manualmente el payout desde el panel de admin.</p>`,
      );
    } catch (e) {
      console.error('[Reconcile Stellar] Error enviando email in_transit:', e.message);
    }
  }

  // ── CASO 3: in_transit >7 días — auto-fail ────────────────────────────────
  const expiredInTransit = await Transaction.find({
    status:    'in_transit',
    updatedAt: { $lt: new Date(now - IN_TRANSIT_GIVEUP_AGE_MS) },
  }).limit(10);

  for (const tx of expiredInTransit) {
    const ageDays = ((now - new Date(tx.updatedAt).getTime()) / 86_400_000).toFixed(1);
    tx.status          = 'failed';
    tx.failureReason   = `[Reconcile Stellar] Tx abandonada: ${ageDays} días en in_transit sin completar.`;
    tx.failureCategory = 'STALE_TRANSIT';
    tx.ipnLog.push({
      provider:   'reconcile-stellar',
      eventType:  'transit_stale_auto_fail',
      status:     'failed',
      rawPayload: { ageDays, at: new Date() },
      receivedAt: new Date(),
    });
    await tx.save().catch(() => {});
    stats.expired++;
    console.warn(`[Reconcile Stellar] ${tx.alytoTransactionId}: marcado failed (${ageDays}d en in_transit)`);
  }

  if (
    stats.retried > 0 || stats.alerted > 0 ||
    stats.expired > 0 || stats.errors  > 0
  ) {
    console.info('[Reconcile Stellar] Stats:', stats);
  }

  return stats;
}
