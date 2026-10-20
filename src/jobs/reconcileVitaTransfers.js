/**
 * reconcileVitaTransfers.js
 *
 * Red de seguridad del payout de Vita. Dos fases independientes:
 *
 * FASE A — transacciones atascadas en payout_sent por IPN perdido:
 *   1. Busca tx en payout_sent + provider vitaWallet + edad > 15 min
 *   2. Por cada tx: intenta GET /transactions/:vitaId (best-effort, Vita es event-driven)
 *   3. Si Vita confirma completed → finaliza (audit trail + comprobante + notif)
 *   4. Si Vita confirma denied   → marca failed + alerta admin
 *   5. Si Vita no tiene el ID o falla   → alerta admin con digest para revisión manual
 *   6. Después de 7 días sin resolución → auto-fail + alerta urgente
 *
 * FASE B — reversiones del proveedor sobre operaciones YA finalizadas:
 *   7. Re-consulta las `completed` de las últimas 72h (con 10 min de gracia)
 *   8. Si Vita informa un estado terminal de fallo → el payout se revirtió después
 *      de que lo declaramos entregado: marca failed, alerta al admin y corrige al
 *      usuario. Un 404 no cuenta como reversión.
 *
 * La fase B existe porque declarar finalidad y dejar de mirar costó una operación
 * real; el detalle del caso está en el bloque de constantes de reversión.
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
import { recordSent }                     from '../controllers/contactsController.js';
import { notify, NOTIFICATIONS }         from '../services/notifications.js';
import { sendEmail, EMAILS }             from '../services/email.js';
import { sendRawEmail }                  from '../services/email.js';
import { mapVitaIpnFailure }             from '../utils/vitaErrorMapper.js';
import { logger }                        from '../utils/logger.js';
import { recordPayoutLeg, completePayinLeg } from '../utils/paymentLegs.js';

const PAYOUT_SENT_AGE_MS       = 15 * 60 * 1000;          // 15 min antes de reconciliar
const MAX_AGE_BEFORE_GIVEUP_MS = 7 * 24 * 60 * 60 * 1000; // 7 días → auto-fail
const ALERT_THRESHOLD_MS       = 2 * 60 * 60 * 1000;      // 2h → alerta admin si sin resolver

// ── Vigilancia de reversiones post-finalización (FASE B) ───────────────────────
// Vita puede REVERTIR un payout horas después de haberlo reportado `completed`.
// Caso real: ALY-C-1792511020004-YDNVM3 — completada 2026-10-20 16:06 con sello en
// Stellar y comprobante emitido; Vita la pasó a `denied` a las 19:50 y devolvió el
// dinero a la cuenta de la SpA. La beneficiaria nunca recibió nada y el usuario
// siguió viendo "Entregado" durante un día entero.
//
// Las DOS vías por las que podríamos habernos enterado estaban cerradas a la vez:
//   1. El IPN de rechazo tardío: `handleVitaIPN` lo atrapa en su "Caso D", pero el
//      canal de IPN de payout de Vita NUNCA se ha disparado en producción (de las
//      7 tx con payout Vita, las 7 se cerraron por reconcile, manual o admin).
//   2. Este job: solo recorría `payout_sent`, así que una vez `completed` nada
//      volvía a mirar la operación.
//
// Como el polling es el único canal que de hecho funciona, no puede detenerse en
// `completed`. GRACE evita re-consultar una tx que acabamos de finalizar;
// WATCH acota hasta cuándo seguimos vigilando (la reversión observada llegó a las
// ~4h, así que 72h es holgado) y mantiene el costo acotado.
const REVERSAL_RECHECK_GRACE_MS = 10 * 60 * 1000;          // 10 min tras completar
const REVERSAL_WATCH_MS         = 72 * 60 * 60 * 1000;     // 72h de vigilancia

// Mapeo estados Vita → acción
const VITA_COMPLETED_STATUSES = new Set(['completed']);
const VITA_FAILED_STATUSES    = new Set(['denied', 'rejected', 'expired', 'cancelled', 'canceled', 'failed', 'returned']);

/**
 * Saca los atributos de la transacción de la respuesta de GET /transactions/:id.
 *
 * ⚠️ Este job leía `resp.data.transaction ?? resp.data.withdrawal ?? resp.data ?? resp`
 * y después `vitaData.status`. La forma REAL que devuelve Vita es
 *   { transaction: { id, type, attributes: { status, included, … } } }
 * — sin envoltorio `data` y con el status un nivel más adentro. El encadenado caía
 * siempre en `resp`, cuya única clave es `transaction`, así que `status` era
 * `undefined` y TODA transacción se clasificaba como "Vita aún trabajando".
 * La red de seguridad corría cada 15 min sin poder resolver nada: un payout
 * denegado se quedaba en payout_sent indefinidamente. (Verificado 2026-08-12
 * contra la respuesta real de api.vitawallet.io para un payout denegado.)
 *
 * Se conservan las variantes antiguas como fallback por si Vita cambia la forma.
 */
export function extractVitaTxAttributes(resp) {
  return resp?.transaction?.attributes
      ?? resp?.data?.transaction?.attributes
      ?? resp?.data?.transaction
      ?? resp?.data?.withdrawal
      ?? resp?.data
      ?? resp;
}

/**
 * Finaliza una transacción Vita cuyo IPN llegó tarde (vía reconcile).
 * Replica el bloque "vitaStatus === 'completed'" de ipnController.handleVitaIPN.
 */
async function finalizeVitaCompleted(transaction) {
  transaction.status      = 'completed';
  transaction.completedAt = new Date();
  // Esta función replica a propósito el bloque 'completed' de
  // ipnController.handleVitaIPN, así que TODO lo que se agregue allá hay que
  // agregarlo acá. El desglose por etapa se perdía justo en este camino —el que
  // corre cuando el IPN de Vita no llega, que es el caso real observado en
  // ALY-C-1791276352443-HD5WWD— y la operación terminaba 'completed' con el
  // payin en 'pending' y sin etapa de payout.
  completePayinLeg(transaction);
  recordPayoutLeg(transaction, {
    provider:    'vitaWallet',
    status:      'completed',
    externalId:  transaction.payoutReference,
    completedAt: transaction.completedAt,
  });
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

  // Registro de contacto (beneficiario frecuente) — paridad con el webhook
  if (transaction.contactId) {
    recordSent(transaction.contactId, transaction.destinationAmount, transaction.destinationCurrency).catch(() => {});
  }

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
async function finalizeVitaFailed(transaction, reason, mapped = null) {
  transaction.status        = 'failed';
  transaction.failureReason = mapped?.adminMessage ?? reason;
  if (mapped) {
    transaction.userFailureReason = mapped.userMessage;
    transaction.userFailureAction = mapped.userAction;
    transaction.failureCategory   = mapped.category;
    transaction.failureRetryable  = mapped.retryable;
  }
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

  // Email al usuario — paridad con el webhook (antes el reconcile fallaba sin avisar por email)
  try {
    const user = await User.findById(transaction.userId).lean();
    if (user?.email) await sendEmail(...EMAILS.paymentFailed(user, transaction));
  } catch { /* best-effort */ }

  logger.warn('[ReconcileVita] ❌ Tx marcada failed vía reconcile', {
    transactionId: transaction.alytoTransactionId,
    reason,
  });
}

/**
 * Una transacción que ya habíamos declarado `completed` resultó revertida por Vita.
 *
 * Se trata aparte de `finalizeVitaFailed` por tres razones:
 *
 *   1. **El estado correcto es `failed`, no `refunded`.** El payout no llegó al
 *      beneficiario y el dinero volvió a la cuenta de Vita, pero al usuario NO se le
 *      devolvió nada todavía. Marcar `refunded` afirmaría una devolución que no ocurrió.
 *   2. **Es aditivo: no se borra nada.** El comprobante y el sello en Stellar ya se
 *      emitieron y quedan donde están. Se registra la reversión encima, igual que un
 *      asiento de contrapartida. Retirar evidencia ya emitida sería peor que conservarla
 *      con su corrección al lado.
 *   3. **El usuario ya vio "Entregado".** Hay que corregirle lo que se le dijo, así que
 *      la notificación no es opcional ni best-effort silencioso.
 *
 * @param {object} transaction — documento Mongoose (no lean)
 * @param {string} vitaStatus — estado terminal que informó Vita (ej. 'denied')
 * @param {object} vitaData — atributos crudos de Vita, para rescatar el motivo
 */
async function handleVitaReversal(transaction, vitaStatus, vitaData) {
  const completedAt = transaction.completedAt;
  const mapped      = mapVitaIpnFailure(vitaData, { stage: 'payout' });
  const reason      =
    `REVERSIÓN tras finalización: Vita pasó el payout a "${vitaStatus}" después de ` +
    `haberlo reportado completado${completedAt ? ` el ${completedAt.toISOString()}` : ''}. ` +
    `El beneficiario no recibió el dinero y el usuario ya tenía la operación como entregada.`;

  transaction.status        = 'failed';
  transaction.failureReason = reason;
  if (mapped) {
    transaction.userFailureReason = mapped.userMessage;
    transaction.userFailureAction = mapped.userAction;
    transaction.failureCategory   = mapped.category;
    transaction.failureRetryable  = mapped.retryable;
  }
  transaction.ipnLog = transaction.ipnLog ?? [];
  transaction.ipnLog.push({
    provider:   'vitaWallet',
    eventType:  'payout_reverted_after_completed',
    status:     'failed',
    rawPayload: {
      source:        'reconcileVitaTransfers',
      vitaStatus,
      completedAt,
      rejectMotive:  vitaData?.reject_motive ?? vitaData?.rejectMotive ?? null,
      vitaStatuses:  vitaData?.statuses ?? null,
      comprobanteYaEmitido: Boolean(transaction.comprobanteUrl ?? transaction.stellarTxId),
    },
    receivedAt: new Date(),
  });
  await transaction.save();

  logger.error('[ReconcileVita] 🔴 REVERSIÓN tras finalización detectada', {
    transactionId: transaction.alytoTransactionId,
    payoutReference: transaction.payoutReference,
    vitaStatus,
    completedAt: completedAt?.toISOString(),
    monto: `${transaction.originalAmount} ${transaction.originCurrency}`,
  });

  await alertAdminReversal(transaction, vitaStatus, reason);

  // Corregirle al usuario lo que ya se le había informado como entregado.
  notify(
    transaction.userId,
    NOTIFICATIONS.paymentFailed(transaction.originalAmount, transaction.originCurrency),
  ).catch(() => {});

  try {
    const user = await User.findById(transaction.userId).lean();
    if (user?.email) await sendEmail(...EMAILS.paymentFailed(user, transaction));
  } catch { /* best-effort */ }
}

/**
 * Alerta al admin de una reversión post-finalización. Va aparte del digest normal
 * porque exige acción: hay dinero cobrado a un usuario al que se le declaró entregado.
 */
async function alertAdminReversal(transaction, vitaStatus, reason) {
  const adminEmail = process.env.SENDGRID_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  const body = `
[Alyto] REVERSIÓN DE PAYOUT TRAS HABERLO DECLARADO ENTREGADO

Transacción: ${transaction.alytoTransactionId}
Referencia Vita: ${transaction.payoutReference ?? 'n/a'}
Estado informado por Vita: ${vitaStatus}
Completada el: ${transaction.completedAt?.toISOString() ?? 'n/a'}
Monto cobrado: ${transaction.originalAmount} ${transaction.originCurrency}
Destino: ${transaction.destinationCountry ?? 'n/a'}

${reason}

Qué revisar:
  • El dinero del payout volvió a la cuenta de Vita. Confirmarlo en el panel de Vita.
  • El cobro al usuario SIGUE TOMADO: corresponde devolución y queda pendiente.
  • El comprobante y el sello en Stellar ya estaban emitidos y NO se retiran: la
    reversión queda asentada encima, no se borra evidencia.
  • La transacción quedó en 'failed' y al usuario ya se le notificó la corrección.

Alyto Backend — ${new Date().toISOString()}
`.trim();

  await sendRawEmail(
    adminEmail,
    `[Alyto] 🔴 Reversión tras entrega — ${transaction.alytoTransactionId}`,
    `<pre style="font-family:monospace;white-space:pre-wrap">${body}</pre>`,
  ).catch(err => logger.error('[ReconcileVita] Error enviando alerta de reversión:', { err: err.message }));
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

  // Firma posicional (to, subject, html) — se llamaba con un objeto y el email
  // de alerta fallaba SIEMPRE en silencio (audit 2026-06-11).
  await sendRawEmail(
    adminEmail,
    `[Alyto] ⚠️ ${transactions.length} tx Vita sin resolver (reconcile)`,
    `<pre style="font-family:monospace;white-space:pre-wrap">${body}</pre>`,
  ).catch(err => logger.error('[ReconcileVita] Error enviando alerta admin:', { err: err.message }));
}

/**
 * Job principal.
 * @returns {Promise<{checked: number, completed: number, failed: number, unresolved: number, autoFailed: number}>}
 */
// Guard de overlap: evita que dos corridas solapadas procesen las mismas
// tx atascadas en paralelo (audit 2026-06-11).
let _isRunning = false;

export async function reconcileVitaTransfers() {
  const stats = {
    checked: 0, completed: 0, failed: 0, unresolved: 0, autoFailed: 0,
    rechecked: 0, reverted: 0,
  };
  if (_isRunning) {
    logger.warn('[ReconcileVita] Corrida anterior aún en curso — skip');
    return { ...stats, skipped: true };
  }
  _isRunning = true;
  try {
    return await _reconcileVitaTransfers(stats);
  } finally {
    _isRunning = false;
  }
}

async function _reconcileVitaTransfers(stats) {
  const now = new Date();

  // Las dos fases son independientes: un fallo en la de atascadas no debe impedir
  // que corra la vigilancia de reversiones, que es la que detecta dinero no entregado
  // en operaciones que el usuario ya ve como completadas.
  try {
    await _faseAtascadas(stats, now);
  } catch (err) {
    logger.error('[ReconcileVita] Error inesperado en la fase de atascadas', { error: err.message });
  }

  try {
    await _faseReversiones(stats, now);
  } catch (err) {
    logger.error('[ReconcileVita] Error inesperado en la fase de reversiones', { error: err.message });
  }

  if (stats.completed || stats.failed || stats.autoFailed || stats.reverted) {
    logger.info('[ReconcileVita] Resultado', stats);
  }

  return stats;
}

/**
 * FASE B — vigila reversiones del proveedor sobre operaciones ya finalizadas.
 *
 * Recorre las `completed` recientes y vuelve a preguntarle a Vita. Si Vita informa
 * un estado terminal de fallo, el payout se revirtió después de que lo declaramos
 * entregado. Ver el bloque de constantes arriba para el caso que originó esto.
 */
async function _faseReversiones(stats, now) {
  const desde = new Date(now.getTime() - REVERSAL_WATCH_MS);
  const hasta = new Date(now.getTime() - REVERSAL_RECHECK_GRACE_MS);

  const completadas = await Transaction.find({
    status:          'completed',
    providersUsed:   'payout:vitaWallet',
    payoutReference: { $exists: true, $ne: null },
    completedAt:     { $gte: desde, $lt: hasta },
  }).limit(50).lean(false);

  if (!completadas.length) return;

  logger.info(`[ReconcileVita] ${completadas.length} tx completadas bajo vigilancia de reversión`);
  stats.rechecked = completadas.length;

  for (const tx of completadas) {
    let vitaData;
    try {
      const resp = await getVitaTransaction(tx.payoutReference);
      vitaData = extractVitaTxAttributes(resp);
    } catch (err) {
      // Un 404 NO es una reversión: Vita devuelve 404 para referencias que no
      // reconoce (3 de las 8 completadas de producción dan 404). Sin dato no se
      // afirma nada — "no sé" no es "se revirtió".
      logger.warn('[ReconcileVita] No se pudo re-verificar tx completada', {
        transactionId: tx.alytoTransactionId,
        vitaId:        tx.payoutReference,
        httpStatus:    err?.response?.status ?? err?.status ?? 'network_error',
      });
      continue;
    }

    const vitaStatus = vitaData?.status?.toLowerCase?.() ?? '';

    if (VITA_FAILED_STATUSES.has(vitaStatus)) {
      await handleVitaReversal(tx, vitaStatus, vitaData);
      stats.reverted++;
    }
    // `completed` o cualquier estado intermedio → sigue en pie, nada que hacer.
  }
}

/**
 * FASE A — recupera transacciones atascadas en `payout_sent` por IPN perdido.
 */
async function _faseAtascadas(stats, now) {
  {
    const minAge = new Date(now.getTime() - PAYOUT_SENT_AGE_MS);

    const stuckTxs = await Transaction.find({
      status:        'payout_sent',
      providersUsed: 'payout:vitaWallet',
      updatedAt:     { $lt: minAge },
    }).limit(50).lean(false); // lean(false) para poder mutar y guardar

    if (!stuckTxs.length) return;

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
        vitaData = extractVitaTxAttributes(resp);
      } catch (err) {
        const httpStatus = err?.response?.status ?? err?.status;
        const isNotFound = httpStatus === 404;
        logger.warn('[ReconcileVita] No se pudo consultar Vita', {
          transactionId: tx.alytoTransactionId,
          vitaId:        tx.payoutReference,
          httpStatus:    httpStatus ?? 'network_error',
          error:         isNotFound ? '404 Not Found' : err.message,
        });
        if (ageMs > ALERT_THRESHOLD_MS) unresolved.push(tx);
        continue;
      }

      const vitaStatus = vitaData?.status?.toLowerCase?.() ?? '';

      logger.info('[ReconcileVita] Vita status recibido', {
        transactionId: tx.alytoTransactionId,
        vitaId:        tx.payoutReference,
        vitaStatus:    vitaStatus || '(vacío)',
        ageMin:        Math.round(ageMs / 60_000),
      });

      if (VITA_COMPLETED_STATUSES.has(vitaStatus)) {
        await finalizeVitaCompleted(tx);
        stats.completed++;
      } else if (VITA_FAILED_STATUSES.has(vitaStatus)) {
        // Se pasa el objeto de Vita al mapper para rescatar reject_motive y demás:
        // el reconcile es la ÚNICA fuente del motivo cuando el IPN nunca llega.
        const mapped = mapVitaIpnFailure(vitaData, { stage: 'payout' });
        await finalizeVitaFailed(
          tx, `Payout denegado por Vita (reconcile): status=${vitaStatus}`, mapped,
        );
        stats.failed++;
      } else {
        // pending / processing / desconocido — Vita aún trabajando
        if (ageMs > ALERT_THRESHOLD_MS) unresolved.push(tx);
      }
    }

    // Alerta admin con digest de no resueltas
    if (unresolved.length) {
      stats.unresolved = unresolved.length;
      await alertAdminUnresolved(unresolved);
    }

  }
}
