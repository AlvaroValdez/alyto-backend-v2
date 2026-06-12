/**
 * reconcileBankQrPayments.js
 *
 * Reconciliación diaria de pagos QR bancarios.
 *
 * Consulta a cada banco registrado la lista de QRs pagados en la fecha
 * actual (GET /api/qrsimple/v2/paidQR/{fecha}) y confirma las transacciones
 * que no recibieron el IPN en tiempo real (webhook caído, red, etc.).
 *
 * Este job es el "safety net" del webhook: el webhook es el camino feliz
 * (confirmación en segundos), este job cierra el gap de confiabilidad.
 *
 * Frecuencia recomendada: cada 30 min (registrar en server.js o EventBridge).
 * Primera corrida: 5 min post-start (deja tiempo para que el banco actualice).
 */

import Transaction from '../models/Transaction.js';
import { listAvailableBankIds, getBankQrService } from '../services/bankQr/bankQrRegistry.js';
import { dispatchPayout } from '../controllers/ipnController.js';
import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';

export async function reconcileBankQrPayments() {
  const today       = new Date();
  const bankIds     = listAvailableBankIds();
  let   totalFixed  = 0;

  if (bankIds.length === 0) return 0;  // ningún banco QR configurado

  for (const bankId of bankIds) {
    try {
      const svc      = getBankQrService(bankId);
      const paidList = await svc.getPaidQRs(today);

      for (const payment of paidList) {
        const tx = await Transaction.findOne({
          'bankQr.qrId': payment.qrId,
          status:        'payin_pending',
        });

        if (!tx) continue;  // ya confirmada por IPN o no existe

        // Usar timestamp real del banco cuando está disponible; fallback a now
        const bankPaidAt = payment.paymentDate && payment.paymentTime
          ? new Date(`${payment.paymentDate.split('T')[0]}T${payment.paymentTime}`)
          : new Date();

        tx.status         = 'payin_confirmed';
        tx.bankQr.paidAt  = isNaN(bankPaidAt) ? new Date() : bankPaidAt;
        tx.bankQr.payment = payment;
        tx.payinReference = payment.qrId;
        tx.ipnLog.push({
          provider:   `bankQr:${bankId}`,
          eventType:  'bankqr_reconciled',
          status:     'payin_confirmed',
          rawPayload: { payment, source: 'reconciliation_job' },
          receivedAt: new Date(),
        });
        await tx.save();

        logger.info(`[reconcileBankQr] ✅ Tx confirmada via reconciliación`, {
          bankId,
          qrId:               payment.qrId,
          alytoTransactionId: tx.alytoTransactionId,
        });

        dispatchPayout(tx).catch((err) => {
          logger.error(`[reconcileBankQr] Error en dispatchPayout`, {
            alytoTransactionId: tx.alytoTransactionId,
            error:              err.message,
          });
          Sentry.captureException(err, {
            tags:  { component: 'reconcileBankQrPayments' },
            extra: { alytoTransactionId: tx.alytoTransactionId, bankId },
          });
        });

        totalFixed++;
      }
    } catch (err) {
      logger.error(`[reconcileBankQr] Error consultando banco ${bankId}:`, err.message);
      Sentry.captureException(err, { tags: { component: 'reconcileBankQrPayments', bankId } });
    }
  }

  if (totalFixed > 0) {
    logger.info(`[reconcileBankQr] ${totalFixed} tx confirmadas via reconciliación`);
  }

  return totalFixed;
}
