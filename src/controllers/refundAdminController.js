/**
 * refundAdminController.js — Ejecutar una devolución desde el panel.
 *
 * Reemplaza lo que hasta ahora era forzar `status: 'refunded'` a mano, que no
 * movía dinero y además liberaba el cupo del Entorno Controlado de Pruebas.
 *
 * Queda auditado igual que el resto de las acciones que mueven dinero: una
 * devolución es una salida de fondos, y el motivo es lo que después la explica.
 */

import * as Sentry from '@sentry/node';

import { executeRefund, REFUND_METHODS } from '../services/refundService.js';
import { recordAdminAction }             from '../services/adminAuditService.js';
import { httpStatusFor }                 from '../services/bank/disbursementService.js';

/** Fallas propias del servicio de devolución; las de dispersión las traduce `httpStatusFor`. */
const HTTP_PROPIO = {
  invalid_request: 400,
  not_found:       404,
  not_refundable:  409,
  in_flight:       409,
  race:            409,
  unsupported:     422,
  credit_failed:   500,
};

/**
 * POST /api/v1/admin/transactions/:transactionId/refund
 *
 * Body: { method?: 'walletBOB'|'bankTransfer', reason, bank?, provider? }
 *
 * `walletBOB` (default) acredita el saldo y cierra la devolución en el acto.
 * `bankTransfer` ordena una transferencia y la deja en curso: el pasivo sigue
 * reconocido hasta que el banco confirme, por webhook o por el job de
 * conciliación.
 */
export async function adminRefundTransaction(req, res) {
  const { transactionId } = req.params;
  const { method = REFUND_METHODS.WALLET, reason, bank, provider } = req.body ?? {};

  try {
    const result = await executeRefund({
      transactionId,
      method,
      reason,
      actorId: req.user?._id,
      bank,
      provider,
    });

    if (!result.ok) {
      const status = HTTP_PROPIO[result.code] ?? httpStatusFor(result.code);
      return res.status(status).json({ error: result.reason, code: result.code });
    }

    // Se audita solo lo que efectivamente movió algo. `state: 'already'` es una
    // llamada repetida sobre una devolución ya hecha, y anotarla como acción
    // nueva ensuciaría el rastro con eventos que no ocurrieron.
    if (result.state !== 'already') {
      await recordAdminAction({
        req,
        action:     'transaction.refund',
        targetType: 'Transaction',
        targetId:   transactionId,
        reason,
        metadata:   {
          method:   result.method,
          state:    result.state,
          wtxId:    result.wtxId,
          // La cuenta destino queda en el rastro, sin el documento: alcanza para
          // reconstruir a dónde fue el dinero.
          ...(method === REFUND_METHODS.BANK
            ? { bankCode: bank?.bankCode, accountHolder: bank?.accountHolder }
            : {}),
        },
      }).catch((err) => {
        // El dinero ya se movió: no se puede deshacer por un fallo de auditoría,
        // pero tampoco puede pasar desapercibido.
        Sentry.captureException(err, {
          tags:  { controller: 'refundAdminController', fn: 'adminRefundTransaction' },
          extra: { transactionId, wtxId: result.wtxId, nota: 'devolución ejecutada sin registro de auditoría' },
        });
      });
    }

    return res.json({
      transactionId,
      method: result.method,
      state:  result.state,
      wtxId:  result.wtxId,
      ...(result.detail ? { detail: result.detail } : {}),
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags:  { controller: 'refundAdminController', fn: 'adminRefundTransaction' },
      extra: { transactionId, method },
    });
    console.error('[Admin refund] Error ejecutando devolución:', err.message);
    return res.status(500).json({ error: 'Error al ejecutar la devolución.' });
  }
}
