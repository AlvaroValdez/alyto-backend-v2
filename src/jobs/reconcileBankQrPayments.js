/**
 * reconcileBankQrPayments.js
 *
 * Red de seguridad del webhook bankQr. Dos responsabilidades:
 *
 *   FASE A — Confirmar pagos que no llegaron por IPN (webhook caído, red, etc.).
 *     Consulta a cada banco la lista de QRs pagados de AYER y HOY
 *     (GET /api/qrsimple/v2/paidQR/{fecha}) y confirma las tx en payin_pending.
 *     La ventana de 2 días cierra el gap del IPN perdido a través de medianoche:
 *     un pago a las 23:55 cuyo IPN se pierde se reconcilia con la corrida de las
 *     00:10 consultando la fecha de ayer.
 *
 *   FASE B — Barrido de expiración (give-up). Las tx bankQr quedaban en
 *     payin_pending para siempre: cleanupOrphanTransactions las excluye (su
 *     confirmación no depende del usuario) y la FASE A solo mira pagos exitosos.
 *     El barrido toma las tx vencidas (paymentInstructionsExpiresAt + gracia),
 *     hace un último getQRStatus en el banco:
 *       - 'paid'      → confirma (cubre cualquier pago que la FASE A no listó)
 *       - 'pending'   → cancela el QR en el banco + marca failed/archived
 *       - 'cancelled' → marca failed/archived
 *     Cancelar antes de marcar failed cierra la carrera "marco failed → el
 *     usuario paga después → dinero recibido sin payout".
 *
 * Frecuencia recomendada: cada 30 min. Primera corrida 5 min post-start.
 */

import Transaction from '../models/Transaction.js';
import WalletTransaction from '../models/WalletTransaction.js';
import {
  listAvailableBankIds,
  listBankIds,
  getBankQrService,
} from '../services/bankQr/bankQrRegistry.js';
import { dispatchPayout } from '../controllers/ipnController.js';
import { confirmBankQrDeposit, failExpiredBankQrDeposit } from '../controllers/walletController.js';
import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';

// Gracia tras el vencimiento antes de dar por perdido el QR — deja margen a un
// IPN que llega tarde justo en el límite del día.
const EXPIRY_GRACE_MS    = 60 * 60 * 1000;          // 1 hora
// Give-up duro: si el banco no responde y la tx es muy vieja, marcar failed
// igual para no acumular zombies (mismo umbral que Harbor/Vita).
const HARD_GIVEUP_MS     = 7 * 24 * 60 * 60 * 1000; // 7 días
const SWEEP_LIMIT        = 50;                       // máx tx por corrida (límite API)

// Guard de overlap: dos corridas solapadas podrían confirmar/cancelar la misma tx.
let _isRunning = false;

/**
 * Confirma una tx bankQr (payin recibido) y dispara el payout.
 * Centraliza la lógica usada por FASE A, FASE B y — en el camino feliz — el IPN.
 */
async function confirmBankQrTx(tx, payment, bankId, source) {
  const bankPaidAt = payment?.paymentDate && payment?.paymentTime
    ? new Date(`${payment.paymentDate.split('T')[0]}T${payment.paymentTime}`)
    : new Date();

  tx.status         = 'payin_confirmed';
  tx.bankQr.paidAt  = isNaN(bankPaidAt) ? new Date() : bankPaidAt;
  tx.bankQr.payment = payment;
  tx.payinReference = payment?.qrId ?? tx.bankQr?.qrId;
  tx.ipnLog.push({
    provider:   'bankQr',
    eventType:  source === 'reconciliation_job' ? 'bankqr_reconciled' : 'bankqr_sweep_confirmed',
    status:     'payin_confirmed',
    rawPayload: { payment, bankId, source },
    receivedAt: new Date(),
  });
  await tx.save();

  logger.info(`[reconcileBankQr] ✅ Tx confirmada (${source})`, {
    bankId,
    qrId:               tx.bankQr?.qrId,
    alytoTransactionId: tx.alytoTransactionId,
  });

  dispatchPayout(tx).catch((err) => {
    logger.error('[reconcileBankQr] Error en dispatchPayout', {
      alytoTransactionId: tx.alytoTransactionId,
      error:              err.message,
    });
    Sentry.captureException(err, {
      tags:  { component: 'reconcileBankQrPayments' },
      extra: { alytoTransactionId: tx.alytoTransactionId, bankId },
    });
  });
}

/** Marca una tx bankQr vencida como fallida (soft-delete para auditoría ASFI). */
async function failExpiredBankQrTx(tx, bankId, reason) {
  tx.status            = 'failed';
  tx.failureReason     = `[bankQr] ${reason}`;
  tx.userFailureReason = 'El código QR de pago expiró sin registrarse el pago. Si ya pagaste, contáctanos.';
  tx.failureCategory   = 'BANKQR_EXPIRED';
  tx.archivedAt        = new Date();
  tx.ipnLog.push({
    provider:   'bankQr',
    eventType:  'bankqr_expired',
    status:     'failed',
    rawPayload: { bankId, reason, sweptAt: new Date() },
    receivedAt: new Date(),
  });
  await tx.save();

  logger.info('[reconcileBankQr] ⏲️ Tx vencida archivada', {
    bankId,
    qrId:               tx.bankQr?.qrId,
    alytoTransactionId: tx.alytoTransactionId,
  });
}

// ── FASE A — confirmar pagos por lista paidQR (ayer + hoy) ─────────────────────
async function reconcilePaidQRs() {
  const bankIds = listAvailableBankIds();
  if (bankIds.length === 0) return 0;

  const today     = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  let   fixed     = 0;

  for (const bankId of bankIds) {
    const svc = getBankQrService(bankId);

    for (const date of [yesterday, today]) {
      let paidList;
      try {
        paidList = await svc.getPaidQRs(date);
      } catch (err) {
        logger.error(`[reconcileBankQr] Error consultando paidQR ${bankId}:`, err.message);
        Sentry.captureException(err, { tags: { component: 'reconcileBankQrPayments', phase: 'A', bankId } });
        continue;
      }

      for (const payment of paidList ?? []) {
        try {
          const tx = await Transaction.findOne({
            'bankQr.qrId': payment.qrId,
            status:        'payin_pending',
          });
          if (tx) {
            await confirmBankQrTx(tx, payment, bankId, 'reconciliation_job');
            fixed++;
            continue;
          }
          // ¿Carga de Wallet BOB con IPN perdido?
          const wtx = await WalletTransaction.findOne({
            'bankQr.qrId': payment.qrId,
            type:          'deposit',
            status:        'pending',
          });
          if (!wtx) continue;  // ya confirmada por IPN o inexistente
          const r = await confirmBankQrDeposit(wtx, payment, bankId, 'reconciliation_job');
          if (r.ok) fixed++;
        } catch (err) {
          logger.error('[reconcileBankQr] Error confirmando tx via paidQR:', err.message);
          Sentry.captureException(err, { tags: { component: 'reconcileBankQrPayments', phase: 'A', bankId } });
        }
      }
    }
  }

  return fixed;
}

// ── FASE B — barrido de expiración (give-up con chequeo final) ─────────────────
async function sweepExpiredQRs() {
  const now        = Date.now();
  const registered = new Set(listBankIds());
  let   handled    = 0;

  const expired = await Transaction.find({
    'bankQr.qrId':                { $exists: true },
    'bankQr.paidAt':              { $exists: false },
    status:                       'payin_pending',
    archivedAt:                   null,
    paymentInstructionsExpiresAt: { $lt: new Date(now - EXPIRY_GRACE_MS) },
  }).limit(SWEEP_LIMIT);

  for (const tx of expired) {
    const bankId = tx.bankQr?.bankId ?? 'bec';
    const ageMs  = now - new Date(tx.paymentInstructionsExpiresAt).getTime();

    try {
      // Banco no registrado o sin servicio → solo give-up duro por antigüedad.
      if (!registered.has(bankId)) {
        if (ageMs > HARD_GIVEUP_MS) { await failExpiredBankQrTx(tx, bankId, `Banco '${bankId}' no registrado — give-up por antigüedad`); handled++; }
        continue;
      }

      const svc = getBankQrService(bankId);

      let statusInfo;
      try {
        statusInfo = await svc.getQRStatus(tx.bankQr.qrId);
      } catch (err) {
        // Banco no responde: give-up duro solo si la tx ya es muy vieja.
        if (ageMs > HARD_GIVEUP_MS) {
          await failExpiredBankQrTx(tx, bankId, `Banco no responde tras ${Math.floor(ageMs / 86400000)}d — give-up`);
          handled++;
        } else {
          logger.warn(`[reconcileBankQr] getQRStatus falló para ${tx.alytoTransactionId} — reintenta próxima corrida:`, err.message);
        }
        continue;
      }

      if (statusInfo.status === 'paid' && statusInfo.payment) {
        // Pagado pero la FASE A no lo listó (fuera de ventana, lag del banco) → confirmar.
        await confirmBankQrTx(tx, statusInfo.payment, bankId, 'sweep');
        handled++;
        continue;
      }

      // Pendiente o cancelado: cancelar en el banco (idempotente) antes de fallar,
      // para que no pueda pagarse después de marcar la tx como failed.
      if (statusInfo.status === 'pending') {
        await svc.cancelQR(tx.bankQr.qrId).catch((err) =>
          logger.warn(`[reconcileBankQr] cancelQR falló para ${tx.bankQr.qrId} (continúo):`, err.message),
        );
      }
      await failExpiredBankQrTx(tx, bankId, `QR vencido (estado banco: ${statusInfo.status})`);
      handled++;
    } catch (err) {
      logger.error(`[reconcileBankQr] Error en barrido de ${tx.alytoTransactionId}:`, err.message);
      Sentry.captureException(err, { tags: { component: 'reconcileBankQrPayments', phase: 'B', bankId } });
    }
  }

  return handled;
}

// ── FASE B (wallet) — barrido de cargas Wallet BOB vencidas ────────────────────
async function sweepExpiredWalletQRs() {
  const now        = Date.now();
  const registered = new Set(listBankIds());
  let   handled    = 0;

  const expired = await WalletTransaction.find({
    'bankQr.qrId':   { $exists: true },
    'bankQr.paidAt': { $exists: false },
    type:            'deposit',
    status:          'pending',
    expiresAt:       { $lt: new Date(now - EXPIRY_GRACE_MS) },
  }).limit(SWEEP_LIMIT);

  for (const wtx of expired) {
    const bankId = wtx.bankQr?.bankId ?? 'bec';
    const ageMs  = now - new Date(wtx.expiresAt).getTime();

    try {
      if (!registered.has(bankId)) {
        if (ageMs > HARD_GIVEUP_MS) { await failExpiredBankQrDeposit(wtx, bankId, `Banco '${bankId}' no registrado — give-up por antigüedad`); handled++; }
        continue;
      }

      const svc = getBankQrService(bankId);

      let statusInfo;
      try {
        statusInfo = await svc.getQRStatus(wtx.bankQr.qrId);
      } catch (err) {
        if (ageMs > HARD_GIVEUP_MS) {
          await failExpiredBankQrDeposit(wtx, bankId, `Banco no responde tras ${Math.floor(ageMs / 86400000)}d — give-up`);
          handled++;
        } else {
          logger.warn(`[reconcileBankQr] getQRStatus wallet falló para ${wtx.wtxId} — reintenta próxima corrida:`, err.message);
        }
        continue;
      }

      if (statusInfo.status === 'paid' && statusInfo.payment) {
        // Pagado fuera de la ventana de FASE A → acreditar.
        const r = await confirmBankQrDeposit(wtx, statusInfo.payment, bankId, 'sweep');
        if (r.ok) handled++;
        continue;
      }

      // Pendiente o cancelado: cancelar en el banco antes de fallar (evita pago tardío).
      if (statusInfo.status === 'pending') {
        await svc.cancelQR(wtx.bankQr.qrId).catch((err) =>
          logger.warn(`[reconcileBankQr] cancelQR wallet falló para ${wtx.bankQr.qrId} (continúo):`, err.message),
        );
      }
      await failExpiredBankQrDeposit(wtx, bankId, `QR vencido (estado banco: ${statusInfo.status})`);
      handled++;
    } catch (err) {
      logger.error(`[reconcileBankQr] Error en barrido wallet de ${wtx.wtxId}:`, err.message);
      Sentry.captureException(err, { tags: { component: 'reconcileBankQrPayments', phase: 'B-wallet', bankId } });
    }
  }

  return handled;
}

export async function reconcileBankQrPayments() {
  if (_isRunning) {
    logger.warn('[reconcileBankQr] Corrida anterior aún en curso — skip');
    return { confirmed: 0, expired: 0, skipped: true };
  }
  _isRunning = true;
  try {
    const confirmed     = await reconcilePaidQRs();
    const expired       = await sweepExpiredQRs();
    const expiredWallet = await sweepExpiredWalletQRs();

    if (confirmed > 0 || expired > 0 || expiredWallet > 0) {
      logger.info(`[reconcileBankQr] ${confirmed} confirmadas, ${expired} vencidas (cross-border), ${expiredWallet} vencidas (wallet)`);
    }
    return { confirmed, expired: expired + expiredWallet };
  } catch (err) {
    logger.error('[reconcileBankQr] Error inesperado en el job:', err.message);
    Sentry.captureException(err, { tags: { component: 'reconcileBankQrPayments' } });
    return { confirmed: 0, expired: 0, error: err.message };
  } finally {
    _isRunning = false;
  }
}
