/**
 * refundService.js — Devolver el dinero de una operación que se cobró y no se ejecutó.
 *
 * ## El problema que resuelve
 *
 * Hasta ahora la devolución no existía como ejecución: existía como etiqueta. Un
 * admin forzaba `status: 'refunded'` desde el panel y eso era todo. El modelo lo
 * dice sin eufemismos: ese estado "se puede fijar a mano sin mover un centavo, y
 * en producción hay exactamente un registro así" (ALY-C-1786548682442-NE1YVC,
 * Bs 236, cobrado, marcado devuelto, sin ningún movimiento detrás).
 *
 * Una etiqueta que afirma una devolución que nadie ejecutó es peor que no tener
 * devolución, porque además libera el cupo del Entorno Controlado de Pruebas.
 *
 * ## Los dos métodos, y por qué el de billetera es el default
 *
 * **`walletBOB`** acredita el saldo en la billetera del usuario. No necesita
 * datos bancarios, es atómico y la prueba queda en el mismo movimiento. Es el
 * camino natural: el usuario ya es usuario, y el dinero vuelve a estar
 * disponible al instante.
 *
 * **`bankTransfer`** devuelve a una cuenta bancaria vía dispersión. Requiere que
 * alguien aporte la cuenta destino, porque **no la tenemos**: un cobro por QR no
 * revela la cuenta del que pagó. `payerAccountNumber` solo existe dentro de la
 * factura B2B, que aplica a cuentas empresa con KYB aprobado. Para todo el resto
 * hay que pedirla.
 *
 * ## La regla contable que ordena todo
 *
 * `refund.wtxId` es lo único que saca el monto del pasivo en `getBOBCommitted`.
 * Por eso se escribe **solo cuando el dinero se movió de verdad**:
 *
 *   - `walletBOB`: en la misma transacción que acredita el saldo.
 *   - `bankTransfer`: recién cuando el banco confirma, no al ordenar.
 *
 * Escribirlo al ordenar una transferencia sería declarar devuelto algo que
 * todavía está en camino y puede rechazarse, y el error caería del lado que
 * favorece a la empresa, que es contra lo que advierte el comentario de
 * `treasuryLiquidity`. Mientras la transferencia está en vuelo el pasivo sigue
 * reconocido, que es lo correcto.
 *
 * Esta regla es también la razón de que no haya que tocar el cálculo de
 * solvencia: el campo conserva exactamente el significado que ya tenía.
 */

import mongoose from 'mongoose';

import Transaction       from '../models/Transaction.js';
import WalletTransaction from '../models/WalletTransaction.js';
import WalletBOB         from '../models/WalletBOB.js';
import { logger }        from '../utils/logger.js';

import { orderPayout, PURPOSES, PAYOUT_ERRORS } from './bank/disbursementService.js';

/** Métodos admitidos. Coinciden con el enum de `Transaction.refund.method`. */
export const REFUND_METHODS = Object.freeze({
  WALLET: 'walletBOB',
  BANK:   'bankTransfer',
});

/**
 * Estados desde los que tiene sentido devolver: el dinero entró y la operación
 * no se completó. 'completed' queda afuera porque el servicio se prestó, y
 * devolverlo sería un ajuste contable distinto, no una devolución.
 */
const REFUNDABLE_STATUSES = [
  'payin_confirmed', 'payin_completed', 'processing', 'in_transit',
  'payout_pending', 'payout_sent', 'payout_pending_usdc_send', 'payout_in_transit',
  'pending_funding', 'pending_fx_review',
  'failed', 'cancelled', 'refunded',
];

const fail = (code, reason) => ({ ok: false, code, reason });

/**
 * ¿Entró el dinero? Se mira la evidencia, no solo el estado, igual que
 * `getBOBCommitted`: el payin puede estar confirmado por QR bancario o por
 * confirmación manual sin que el estado lo refleje.
 */
function payinSettled(tx) {
  return REFUNDABLE_STATUSES.includes(tx.status)
      || Boolean(tx.bankQr?.paidAt)
      || Boolean(tx.confirmationDetails?.confirmedAt);
}

/**
 * Devuelve el dinero de una operación cobrada y no ejecutada.
 *
 * Idempotente: si ya hay evidencia de restitución (`refund.wtxId`), no vuelve a
 * mover nada. Si hay una transferencia en vuelo, lo dice en vez de ordenar una
 * segunda.
 *
 * @param {object} p
 * @param {string} p.transactionId — alytoTransactionId
 * @param {'walletBOB'|'bankTransfer'} [p.method] — default walletBOB
 * @param {string} p.reason        — motivo, queda en la auditoría
 * @param {string} [p.actorId]     — admin que la ordena
 * @param {object} [p.bank]        — { accountNumber, bankCode, accountHolder, docId }; obligatorio para bankTransfer
 * @param {string} [p.provider]    — proveedor de dispersión; omitido usa el default
 *
 * @returns {Promise<
 *   { ok: true,  method: string, state: 'settled'|'dispatched'|'already', wtxId: string, detail?: string }
 * | { ok: false, code: string, reason: string }
 * >}
 */
export async function executeRefund({ transactionId, method = REFUND_METHODS.WALLET, reason, actorId, bank, provider } = {}) {
  if (!transactionId) return fail('invalid_request', 'transactionId es requerido');
  if (!Object.values(REFUND_METHODS).includes(method)) {
    return fail('invalid_request', `método inválido '${method}'; válidos: ${Object.values(REFUND_METHODS).join(', ')}`);
  }
  // El motivo no es trámite: es lo que después explica el movimiento en la
  // auditoría y en el expediente. El panel ya lo exige para forzar un estado
  // terminal a mano; una devolución que sí mueve dinero no puede pedir menos.
  if (!reason || String(reason).trim().length < 10) {
    return fail('invalid_request', 'reason es requerido y debe tener al menos 10 caracteres');
  }

  const tx = await Transaction.findOne({ alytoTransactionId: transactionId });
  if (!tx) return fail('not_found', 'Transacción no encontrada.');

  if (tx.originCurrency !== 'BOB') {
    return fail('unsupported', `La devolución automática solo cubre operaciones cobradas en BOB (esta es ${tx.originCurrency}).`);
  }
  if (!payinSettled(tx)) {
    return fail('not_refundable', `No hay evidencia de cobro para '${transactionId}' (estado '${tx.status}'): no hay nada que devolver.`);
  }
  if (tx.status === 'completed') {
    return fail('not_refundable', 'La operación se completó: el servicio se prestó y esto sería un ajuste, no una devolución.');
  }

  // ── Idempotencia ───────────────────────────────────────────────────────────
  if (tx.refund?.wtxId) {
    return { ok: true, method: tx.refund.method, state: 'already', wtxId: tx.refund.wtxId, detail: 'ya había evidencia de restitución' };
  }

  const amount = Number(tx.originalAmount);
  if (!(amount > 0)) return fail('invalid_request', `La operación no tiene un monto devolvible (originalAmount=${tx.originalAmount}).`);

  // Una devolución anterior que quedó en vuelo. Ordenar otra sería un segundo
  // débito por el mismo motivo.
  const enVuelo = await WalletTransaction.findOne({
    type:     'refund',
    status:   { $in: ['pending', 'dispatched'] },
    'metadata.refundFor': transactionId,
  });
  if (enVuelo) {
    return fail('in_flight', `Ya hay una devolución en curso para '${transactionId}' (${enVuelo.wtxId}, estado '${enVuelo.status}').`);
  }

  return method === REFUND_METHODS.WALLET
    ? refundToWallet({ tx, amount, reason, actorId })
    : refundToBank({ tx, amount, reason, actorId, bank, provider });
}

/**
 * Devolución a la billetera: crédito y evidencia en la misma transacción de base
 * de datos. O quedan las dos cosas, o no queda ninguna.
 */
async function refundToWallet({ tx, amount, reason, actorId }) {
  // Se crea la billetera si no existe, como hace todo otro camino de crédito.
  // Una devolución no puede fallar porque el usuario nunca abrió la billetera:
  // el dinero es suyo y ya lo había entregado.
  const { getOrCreateWallet } = await import('../controllers/walletController.js');
  const wallet = await getOrCreateWallet(tx.userId);

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const prevBalance = wallet.balance;
    const newBalance  = prevBalance + amount;

    const [wtx] = await WalletTransaction.create([{
      walletId:      wallet._id,
      userId:        tx.userId,
      // 'refund' y no 'deposit': el usuario no trajo dinero nuevo, se le
      // devuelve el que ya había entregado. Contarlo como depósito inflaría el
      // volumen de captación, que es una de las cifras que se reporta.
      type:          'refund',
      currency:      'BOB',
      walletModel:   'WalletBOB',
      amount,
      status:        'completed',
      balanceBefore: prevBalance,
      balanceAfter:  newBalance,
      confirmedAt:   new Date(),
      reference:     tx.alytoTransactionId,
      metadata:      { refundFor: tx.alytoTransactionId, refundMethod: REFUND_METHODS.WALLET, reason, by: actorId },
    }], { session });

    await WalletBOB.updateOne({ _id: wallet._id }, { $inc: { balance: amount } }, { session });

    // Guard atómico: solo una devolución puede escribir la evidencia. Si otra
    // la escribió entre la lectura y acá, esto no modifica nada y se aborta.
    const claim = await Transaction.updateOne(
      { _id: tx._id, $or: [{ 'refund.wtxId': { $exists: false } }, { 'refund.wtxId': { $in: [null, ''] } }] },
      {
        $set: {
          status: 'refunded',
          refund: {
            method: REFUND_METHODS.WALLET,
            wtxId:  wtx.wtxId,
            amount,
            currency: 'BOB',
            at:     new Date(),
            by:     actorId,
            reason,
          },
        },
      },
      { session },
    );
    if (claim.modifiedCount === 0) {
      await session.abortTransaction();
      return fail('race', 'Otra devolución escribió la evidencia primero; no se acreditó nada.');
    }

    await session.commitTransaction();

    logger.info('[devolución] Saldo acreditado en billetera', {
      transactionId: tx.alytoTransactionId, wtxId: wtx.wtxId, amount,
    });

    return { ok: true, method: REFUND_METHODS.WALLET, state: 'settled', wtxId: wtx.wtxId };
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    logger.error('[devolución] Falló el crédito en billetera', {
      transactionId: tx.alytoTransactionId, error: err.message,
    });
    return fail('credit_failed', `No se pudo acreditar el saldo: ${err.message}`);
  } finally {
    session.endSession();
  }
}

/**
 * Devolución a una cuenta bancaria, vía el servicio compartido de dispersión.
 *
 * Deja un `WalletTransaction` de tipo 'refund' como registro de seguimiento, con
 * la misma secuencia de estados que un retiro (`pending → dispatched →
 * completed`), pero **sin tocar el saldo en ningún momento**: el dinero no pasa
 * por la billetera, va del banco al banco.
 *
 * La evidencia contable (`refund.wtxId`) la escribe `settleDispatchedRefund`
 * cuando el banco confirma, no acá.
 */
async function refundToBank({ tx, amount, reason, actorId, bank, provider }) {
  const b = bank ?? {};
  if (!b.accountNumber || !b.bankCode || !b.accountHolder) {
    return fail(
      'invalid_request',
      'Para devolver a una cuenta bancaria hacen falta accountNumber, bankCode y accountHolder. ' +
      'No los tenemos guardados: un cobro por QR no revela la cuenta de quien pagó.',
    );
  }

  // `walletId` es obligatorio en el modelo, así que el registro de seguimiento
  // necesita una billetera aunque el dinero no pase por ella. Se crea si falta,
  // y es el caso más probable de este método: alguien que pagó por QR y quiere
  // la devolución en su cuenta bancaria no tiene por qué tener billetera.
  const { getOrCreateWallet } = await import('../controllers/walletController.js');
  const wallet = await getOrCreateWallet(tx.userId);

  // Registro de seguimiento. No mueve saldo: `amount` es lo que se devuelve y
  // `balanceBefore/After` quedan iguales justamente para que se lea que la
  // billetera no participó.
  const wtx = await WalletTransaction.create({
    walletId:      wallet._id,
    userId:        tx.userId,
    type:          'refund',
    currency:      'BOB',
    walletModel:   'WalletBOB',
    amount,
    status:        'pending',
    balanceBefore: wallet.balance,
    balanceAfter:  wallet.balance,
    reference:     tx.alytoTransactionId,
    metadata:      {
      refundFor:     tx.alytoTransactionId,
      refundMethod:  REFUND_METHODS.BANK,
      reason,
      by:            actorId,
      method:        'bank',
      accountNumber: b.accountNumber,
      accountHolder: b.accountHolder,
      accountType:   b.accountType,
      bankCode:      b.bankCode,
    },
  });

  const result = await orderPayout({
    provider,
    reference:   wtx.wtxId,
    targetModel: 'WalletTransaction',
    amount,
    currency:    'BOB',
    purpose:     PURPOSES.REFUND,
    description: `Devolución Alyto ${tx.alytoTransactionId}`,
    beneficiary: {
      accountCode: b.accountNumber,
      bankCode:    b.bankCode,
      name:        b.accountHolder,
      accountType: b.accountType,
      ...(b.docId ? { docId: b.docId } : {}),
    },
    // Declaración honesta de la operación: el dinero sale de lo que el usuario
    // pagó y vuelve a él. No es el texto de un retiro, y por eso el servicio
    // compartido no pone defaults.
    amlData: {
      source:      `Devolución de operación no ejecutada ${tx.alytoTransactionId}, cobrada en bolivianos`,
      destination: `Restitución al ordenante ${b.accountHolder}`,
    },
    claim: async ({ provider: resolvedProvider }) => {
      const claimed = await WalletTransaction.updateOne(
        { _id: wtx._id, status: 'pending' },
        { $set: { status: 'dispatched', 'metadata.disbursementProvider': resolvedProvider, 'metadata.dispatchedAt': new Date() } },
      );
      return claimed.modifiedCount > 0;
    },
    revert: async () => {
      await WalletTransaction.updateOne({ _id: wtx._id, status: 'dispatched' }, { $set: { status: 'pending' } });
    },
  });

  if (!result.ok) {
    // Si no se movió nada, el registro de seguimiento no debe quedar como
    // basura que bloquee el próximo intento por el guard de 'en vuelo'.
    if (result.retryable) {
      await WalletTransaction.updateOne(
        { _id: wtx._id, status: { $in: ['pending', 'dispatched'] } },
        { $set: { status: 'failed', failureReason: result.reason } },
      ).catch(() => {});
    }
    return fail(result.code, result.reason);
  }

  await WalletTransaction.updateOne(
    { _id: wtx._id },
    { $set: { 'metadata.bankBatchId': result.bankBatchId, 'metadata.dispatchMock': result.mock } },
  );

  logger.info('[devolución] Transferencia ordenada al banco', {
    transactionId: tx.alytoTransactionId, wtxId: wtx.wtxId, amount,
    provider: result.provider, bankBatchId: result.bankBatchId,
  });

  return {
    ok:     true,
    method: REFUND_METHODS.BANK,
    state:  'dispatched',
    wtxId:  wtx.wtxId,
    detail: 'ordenada al banco; el pasivo sigue reconocido hasta que confirme',
  };
}

/**
 * Cierra una devolución por transferencia cuando el banco responde.
 *
 * Es el equivalente de `settleDispatchedWithdrawal` para devoluciones, y la
 * diferencia es justamente la que importa: **no mueve saldo**. Un retiro debita
 * la billetera; una devolución bancaria nunca la tocó. Lo único que hace al
 * aceptar es escribir la evidencia que saca el monto del pasivo.
 *
 * Por eso no se puede reusar el settle del retiro: ahí el camino aceptado
 * debita, y aplicado a una devolución le cobraría al usuario el dinero que se le
 * está devolviendo.
 *
 * @param {string} wtxId
 * @param {object} p
 * @param {boolean} p.accepted
 * @param {string} [p.bankReference]
 * @param {string} [p.reason]
 */
export async function settleDispatchedRefund(wtxId, { accepted, bankReference, reason } = {}) {
  const wtx = await WalletTransaction.findOne({ wtxId });
  if (!wtx || wtx.type !== 'refund') return { ok: false, reason: 'not-found' };

  if (wtx.status === 'completed' || wtx.status === 'failed') {
    return { ok: true, reason: 'already-settled', status: wtx.status };
  }
  if (wtx.status !== 'dispatched') return { ok: false, reason: `bad-status-${wtx.status}` };

  const transactionId = wtx.metadata?.refundFor;

  if (!accepted) {
    await WalletTransaction.updateOne(
      { _id: wtx._id, status: 'dispatched' },
      { $set: { status: 'failed', failureReason: reason ?? 'El banco rechazó la devolución.' } },
    );
    logger.warn('[devolución] El banco rechazó la transferencia; el pasivo sigue en pie', {
      wtxId, transactionId, reason,
    });
    // No se escribe evidencia: el dinero no volvió, así que el monto sigue
    // contando como pasivo. Es lo correcto, y además deja el caso visible.
    return { ok: true, status: 'failed' };
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const claim = await WalletTransaction.updateOne(
      { _id: wtx._id, status: 'dispatched' },
      { $set: { status: 'completed', confirmedAt: new Date(), 'metadata.bankReference': bankReference } },
      { session },
    );
    if (claim.modifiedCount === 0) {
      await session.abortTransaction();
      return { ok: false, reason: 'already-settled' };
    }

    // Recién acá la operación sale del pasivo: el banco confirmó que el dinero
    // volvió. Antes de esto habría sido una afirmación sin respaldo.
    if (transactionId) {
      await Transaction.updateOne(
        { alytoTransactionId: transactionId },
        {
          $set: {
            status: 'refunded',
            refund: {
              method:   REFUND_METHODS.BANK,
              wtxId:    wtx.wtxId,
              amount:   wtx.amount,
              currency: 'BOB',
              at:       new Date(),
              by:       wtx.metadata?.by,
              reason:   wtx.metadata?.reason,
            },
          },
        },
        { session },
      );
    }

    await session.commitTransaction();

    logger.info('[devolución] Confirmada por el banco; pasivo liberado', {
      wtxId, transactionId, amount: wtx.amount, bankReference,
    });

    return { ok: true, status: 'completed' };
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    logger.error('[devolución] Falló el cierre de la devolución confirmada', { wtxId, error: err.message });
    return { ok: false, reason: err.message };
  } finally {
    session.endSession();
  }
}

export { PAYOUT_ERRORS };
