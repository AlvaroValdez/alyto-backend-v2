/**
 * reconcileHarborTransfers.js
 *
 * Recupera transacciones Harbor cuyo status quedó "atascado" por webhook
 * perdido. Consulta el status real de Harbor via API y reconcilia.
 *
 * Casos cubiertos:
 *   completed (últimas 72h)                           → poll Harbor → detecta REVERSIÓN
 *   payout_sent (>15 min sin transition)              → poll Harbor → completed | failed
 *   payout_pending_usdc_send (>2h sin USDC send)      → alert admin
 *   failed + failureRetryable=true + TRANSIENT_ERROR  → reintento automático (hasta 3x, backoff 5 min)
 *
 * El primero existe porque declarar finalidad y dejar de mirar ya costó una
 * operación real en Vita (ALY-C-1792511020004-YDNVM3): el proveedor revirtió el
 * payout 4 horas después de reportarlo completado y el usuario siguió viendo
 * "Entregado". Acá el agravante es que el USDC salió on-chain de la tesorería.
 *
 * Triggers:
 *   - setInterval en server.js cada 15 min
 *   - POST /api/v1/admin/reconcile-harbor (manual desde admin)
 */

import Transaction         from '../models/Transaction.js';
import TransactionConfig  from '../models/TransactionConfig.js';
import { getTransferStatus, getCustomerUuid } from '../services/owlPayService.js';
import { sendRawEmail }    from '../services/email.js';
import { tryOwlPayV2, generateComprobanteOnCompletion, notifyTransactionCompleted, notifyTransactionFailed } from '../controllers/ipnController.js';
import { registerAuditTrail } from '../services/stellarService.js';
import { mapHarborError } from '../utils/harborErrorMapper.js';
import { recordPayoutLeg, completePayinLeg } from '../utils/paymentLegs.js';

// Edad mínima antes de reconciliar — evita race condition con webhook que
// llega normal en segundos. Si webhook no llegó en 15 min, ya hay problema.
const PAYOUT_SENT_AGE_MS         = 15 * 60 * 1000;       // 15 min
const PAYOUT_PENDING_USDC_AGE_MS = 2  * 60 * 60 * 1000;  // 2 horas
const MAX_AGE_BEFORE_GIVEUP_MS   = 7  * 24 * 60 * 60 * 1000; // 7 días (auto-fail)

// Parámetros de reintento automático para TRANSIENT_ERROR
const MAX_RECONCILE_RETRIES = 3;
const RETRY_BACKOFF_MS      = 5 * 60 * 1000; // 5 min mínimo entre reintentos

// ── Vigilancia de reversiones tras finalización ───────────────────────────────
// Mismo hueco que se cerró en Vita el 2026-10-20: el job solo miraba estados no
// terminales, así que una vez `completed` nada volvía a mirar la operación. Si el
// proveedor revierte después, seguimos diciéndole "Entregado" al usuario.
//
// Harbor NO es igual a Vita y por eso esto no es una copia:
//
//   1. **El ancla temporal tiene que ser `updatedAt`, no `completedAt`.** Las 3
//      transacciones Harbor completadas de producción tienen `completedAt` NULO
//      (las 4 de Vita lo tienen). Filtrar por `completedAt` habría dejado la fase
//      inerte sin que nada avisara, que es el peor resultado posible para una red
//      de seguridad: parece puesta y no mira nada.
//   2. **Acá el dinero se movió de verdad.** En Vita el payout va contra saldo
//      prefondeado de la SpA; en Harbor sale USDC on-chain de la tesorería SRL
//      (`sendUSDCToHarbor`). Una reversión deja USDC fuera, así que la alerta tiene
//      que apuntar a dónde fue: Harbor publica `refund_address` en el transfer.
//   3. **Harbor tiene `refunded` propio**, que Vita no tiene. Aun así la operación
//      queda en `failed` — ver `handleHarborReversal` para el motivo.
//
// Al 2026-10-20 las 3 completadas siguen `completed` en Harbor: no hay ninguna
// reversión pendiente de detectar. Esto es prevención, no limpieza.
const REVERSAL_RECHECK_GRACE_MS = 10 * 60 * 1000;      // 10 min tras finalizar
const REVERSAL_WATCH_MS         = 72 * 60 * 60 * 1000; // 72 h de vigilancia

/** Estados de Harbor que, sobre una tx ya completada, significan reversión. */
const HARBOR_REVERSAL_STATUSES = new Set(['failed', 'expired', 'cancelled', 'canceled', 'refunded']);

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

/**
 * Una transacción que ya habíamos declarado `completed` resultó revertida por Harbor.
 *
 * **Queda en `failed`, no en `refunded`, incluso cuando Harbor dice `refunded`.**
 * Parece contradictorio y es deliberado: lo que Harbor devuelve es el USDC a la
 * tesorería (a su `refund_address`), no los bolivianos al usuario. Marcar `refunded`
 * afirmaría que el cliente recuperó su dinero, y no lo recuperó. Mismo criterio que
 * en la reversión de Vita.
 *
 * Es aditivo: el comprobante y el sello en Stellar ya emitidos se conservan y la
 * reversión se asienta encima. No se retira evidencia.
 *
 * @param {object} tx — documento Mongoose
 * @param {string} harborStatus — estado que informó Harbor
 * @param {object} data — cuerpo del transfer de Harbor
 */
async function handleHarborReversal(tx, harborStatus, data) {
  const completadaEl = tx.completedAt ?? tx.updatedAt;
  const refundAddress = data?.refund_address ?? null;

  tx.status        = 'failed';
  tx.failureReason =
    `REVERSIÓN tras finalización: Harbor pasó el transfer a "${harborStatus}" después de ` +
    `haberlo reportado completado${completadaEl ? ` (${new Date(completadaEl).toISOString()})` : ''}. ` +
    `El USDC salió de la tesorería on-chain, así que hay que verificar dónde quedó.`;
  tx.userFailureReason = 'No pudimos completar tu transferencia. Nuestro equipo ya está revisando el caso.';
  tx.failureCategory   = 'PROVIDER_REVERSAL';
  tx.failureRetryable  = false;

  tx.ipnLog = tx.ipnLog ?? [];
  tx.ipnLog.push({
    provider:   'owlPay',
    eventType:  'payout_reverted_after_completed',
    status:     'failed',
    rawPayload: {
      source:        'reconcileHarborTransfers',
      harborStatus,
      harborSubStatus: data?.sub_status ?? null,
      refundAddress,
      transferId:    tx.harborTransfer?.transferId ?? null,
      usdcEnviado:   tx.digitalAssetAmount ?? null,
      completadaEl,
      comprobanteYaEmitido: Boolean(tx.comprobanteUrl ?? tx.stellarTxId),
    },
    receivedAt: new Date(),
  });
  await tx.save();

  console.error('[Reconcile] 🔴 REVERSIÓN tras finalización detectada (Harbor)', {
    transactionId: tx.alytoTransactionId,
    transferId:    tx.harborTransfer?.transferId,
    harborStatus,
    usdcEnviado:   tx.digitalAssetAmount,
    refundAddress,
  });

  await alertAdminHarborReversal(tx, harborStatus, refundAddress);

  // Corregirle al usuario lo que ya se le había informado como entregado.
  notifyTransactionFailed(tx).catch(() => {});
}

/**
 * Alerta de reversión Harbor. Va aparte de los avisos del job porque acá hay USDC
 * que salió de la tesorería y hay que ir a buscarlo.
 */
async function alertAdminHarborReversal(tx, harborStatus, refundAddress) {
  const destinatario = process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@alyto.app';
  const cuerpo = `
[Alyto] REVERSIÓN DE PAYOUT HARBOR TRAS HABERLO DECLARADO ENTREGADO

Transacción:     ${tx.alytoTransactionId}
Transfer Harbor: ${tx.harborTransfer?.transferId ?? 'n/a'}
Estado Harbor:   ${harborStatus}
USDC enviado:    ${tx.digitalAssetAmount ?? '?'} USDC
Cobrado:         ${tx.originalAmount} ${tx.originCurrency}
Destino:         ${tx.destinationCountry ?? 'n/a'}

Qué revisar, en este orden:
  1. DÓNDE ESTÁ EL USDC. Salió on-chain de la tesorería SRL. Harbor declara como
     dirección de devolución: ${refundAddress ?? '(no la publicó)'}
     Verificar en Stellar si volvió; si no volvió, reclamarlo a OwlPay.
  2. El cobro al usuario SIGUE TOMADO: corresponde devolución, aún pendiente.
  3. El comprobante y el sello en Stellar ya estaban emitidos y NO se retiran: la
     reversión queda asentada encima, sin borrar evidencia.
  4. La operación quedó en 'failed' (no 'refunded': el usuario no recuperó nada).

Alyto Backend — ${new Date().toISOString()}
`.trim();

  await sendRawEmail(
    destinatario,
    `[Alyto] 🔴 Reversión Harbor tras entrega — ${tx.alytoTransactionId}`,
    `<pre style="font-family:monospace;white-space:pre-wrap">${cuerpo}</pre>`,
  ).catch(e => console.error('[Reconcile] Error email de reversión Harbor:', e.message));
}

/**
 * FASE 0 — vigila reversiones de Harbor sobre operaciones ya finalizadas.
 *
 * Ancla en `updatedAt` a propósito: ver el bloque de constantes. Un error al
 * consultar Harbor NO cuenta como reversión — sin dato no se afirma nada.
 */
async function _faseReversiones(stats, now) {
  const desde = new Date(now - REVERSAL_WATCH_MS);
  const hasta = new Date(now - REVERSAL_RECHECK_GRACE_MS);

  const completadas = await Transaction.find({
    status: 'completed',
    'harborTransfer.transferId': { $exists: true, $ne: null },
    updatedAt: { $gte: desde, $lt: hasta },
  }).limit(50);

  if (!completadas.length) return;

  console.info(`[Reconcile] ${completadas.length} tx Harbor completadas bajo vigilancia de reversión`);
  stats.rechecked = completadas.length;

  for (const tx of completadas) {
    let data;
    try {
      const result = await getTransferStatus(tx.harborTransfer.transferId);
      data = result?.data ?? result;
    } catch (err) {
      console.warn(`[Reconcile] No se pudo re-verificar ${tx.alytoTransactionId}:`, err.message);
      continue;
    }

    const harborStatus = data?.status;
    if (HARBOR_REVERSAL_STATUSES.has(harborStatus)) {
      await handleHarborReversal(tx, harborStatus, data);
      stats.reverted++;
    }
    // `completed` o cualquier estado intermedio → sigue en pie, nada que hacer.
  }
}

async function _reconcileHarborTransfers() {
  const now = Date.now();
  const stats = { reconciled: 0, completed: 0, failed: 0, unchanged: 0, errors: 0, expired: 0, unknown: 0, retried: 0, retriedFailed: 0, retriedExhausted: 0, rechecked: 0, reverted: 0 };

  // ── 0. Reversiones tras finalización ────────────────────────────────────
  // Va PRIMERO y con su propio try/catch, por dos razones: nada de lo que sigue
  // puede impedir que corra (las secciones de abajo no están envueltas, así que un
  // fallo en la primera se llevaba puestas las demás), y un fallo suyo no toca al
  // resto. Es la fase que detecta dinero no entregado, así que no puede quedar
  // detrás de nada.
  try {
    await _faseReversiones(stats, now);
  } catch (err) {
    console.error('[Reconcile] Error en la fase de reversiones:', err.message);
  }

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
        tx.ipnLog.push({
          provider:   'reconcile',
          eventType:  'harbor_stale_giveup_failed',
          status:     'failed',
          rawPayload: { ageDays: Math.floor(ageMs/86400000), harborStatus, polledAt: new Date() },
          receivedAt: new Date(),
        });
        await tx.save();
        stats.expired++;
        // Avisar al usuario + admin del fallo — paridad con el webhook.
        notifyTransactionFailed(tx).catch(() => {});
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
        // Mismo criterio que el post-proceso de arriba: este camino corre cuando
        // el webhook de Harbor se perdió, y el desglose por etapa se quedaba sin
        // cerrar. Ver utils/paymentLegs.js.
        completePayinLeg(tx);
        recordPayoutLeg(tx, {
          provider:    'owlPay',
          status:      'completed',
          externalId:  tx.harborTransfer?.transferId,
          completedAt: new Date(),
        });
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
        // Notificar al usuario (push + email + contacto) — paridad con el webhook.
        notifyTransactionCompleted(tx).catch(() => {});
      }
      if (alytoStatus === 'failed') {
        stats.failed++;
        // Avisar al usuario + admin del fallo — paridad con el webhook.
        notifyTransactionFailed(tx).catch(() => {});
      }
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

  if (stats.reconciled > 0 || stats.errors > 0 || stats.expired > 0 || stats.unknown > 0 || stats.retried > 0 || stats.retriedFailed > 0 || stats.reverted > 0) {
    console.info('[Reconcile] Stats:', stats);
  }
  return stats;
}
