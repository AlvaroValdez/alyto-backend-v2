/**
 * walletPaymentService.js — Pago transfronterizo financiado con saldo USDC
 *
 * Permite que un usuario SRL pague un crossBorderPayment debitando su saldo
 * USDC custodiado (Wallet USDC), en vez de cobrar por QR bancario o transferencia.
 *
 * Modelo hold (reserva → confirma), idéntico al de la conversión BOB↔USDC:
 *   1. reserveUSDCForPayment  — mueve el monto a balanceReserved (NO debita aún).
 *                               Se ejecuta al crear la transacción. Atómico: re-verifica
 *                               el disponible en la misma operación (anti double-spend).
 *   2. confirmUSDCPayment     — debita balance y libera la reserva. Se ejecuta cuando el
 *                               payout llega a 'completed'/'payout_sent'.
 *   3. releaseUSDCReservation — libera la reserva sin debitar. Se ejecuta cuando el payout
 *                               falla (rollback), devolviendo el saldo al usuario.
 *
 * La transacción sigue denominada en BOB (fees, tramos ASFI y límites ECP no cambian):
 * lo único que aporta este servicio es el origen de los fondos. El monto en USDC a
 * reservar es el bruto BOB convertido a la tasa bloqueada de la cotización.
 *
 * Cada paso deja una WalletTransaction (type 'crossborder_payin') con balanceBefore/After
 * para auditoría ASFI. `reference` = alytoTransactionId → idempotencia y trazabilidad.
 *
 * EXCLUSIVO para usuarios legalEntity === 'SRL'.
 */

import mongoose from 'mongoose'

import WalletUSDC        from '../models/WalletUSDC.js'
import WalletTransaction from '../models/WalletTransaction.js'
import Transaction       from '../models/Transaction.js'

/** Estados terminales del payout que liberan la reserva (rollback). */
const RELEASE_STATUSES = new Set(['failed', 'refunded', 'cancelled'])

const round6 = n => Math.round(n * 1e6) / 1e6

/** Error de negocio con statusCode, para que el controller responda el HTTP correcto. */
function bizError(statusCode, message, code) {
  const err = new Error(message)
  err.statusCode = statusCode
  if (code) err.code = code
  return err
}

/**
 * Convierte un monto bruto en BOB al USDC a debitar, usando la tasa bloqueada.
 * Es la MISMA tasa (bobPerUsdc) con la que la cotización calcula el USDC de tránsito,
 * así que no introduce FX drift: la diferencia entre lo debitado y lo liquidado es el fee.
 *
 * @param {number} amountBOB   monto bruto de la operación en BOB (originAmount)
 * @param {number} bobPerUsdc  tasa BOB→USDC bloqueada
 * @returns {number} monto en USDC a reservar/debitar (6 decimales)
 */
export function bobToUsdcDebit(amountBOB, bobPerUsdc) {
  if (!(amountBOB > 0))   throw bizError(400, 'amountBOB debe ser positivo.')
  if (!(bobPerUsdc > 0))  throw bizError(400, 'bobPerUsdc debe ser positivo.')
  return round6(amountBOB / bobPerUsdc)
}

/** Ejecuta `core` dentro de la sesión provista, o abre una propia con transacción. */
async function withSession(session, core) {
  if (session) return core(session)
  const s = await mongoose.startSession()
  s.startTransaction()
  try {
    const result = await core(s)
    await s.commitTransaction()
    return result
  } catch (err) {
    await s.abortTransaction()
    throw err
  } finally {
    s.endSession()
  }
}

/**
 * Reserva (hold) el saldo USDC del usuario para financiar un pago transfronterizo.
 *
 * Requiere una `session` externa: se ejecuta junto con Transaction.create para que el
 * hold y la creación de la transacción sean atómicos (si la tx no se crea, no queda una
 * reserva colgada). El caller es responsable de hacer commit/abort de la sesión.
 *
 * Idempotente por `transactionId`: si ya existe una reserva/débito para esa transacción,
 * la devuelve sin volver a reservar.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {number} p.usdcAmount     monto USDC a reservar (usar bobToUsdcDebit)
 * @param {string} p.transactionId  alytoTransactionId de la transacción
 * @param {number} p.bobPerUsdc     tasa bloqueada (auditoría)
 * @param {number} p.amountBOB      monto bruto BOB (auditoría)
 * @param {string} [p.corridorCode]
 * @param {import('mongoose').ClientSession} p.session  sesión externa (obligatoria)
 * @returns {Promise<{ wtxId: string, usdcAmount: number, walletUSDCId: string }>}
 */
export async function reserveUSDCForPayment({
  userId, usdcAmount, transactionId, bobPerUsdc, amountBOB, corridorCode, session,
}) {
  if (!session)                    throw bizError(500, 'reserveUSDCForPayment requiere una sesión externa.')
  if (!userId)                     throw bizError(400, 'userId es requerido.')
  if (!transactionId)              throw bizError(400, 'transactionId es requerido.')
  if (!(usdcAmount > 0))           throw bizError(400, 'usdcAmount debe ser positivo.')

  const amount = round6(usdcAmount)

  // Idempotencia: no reservar dos veces para la misma transacción (retry con Idempotency-Key).
  const existing = await WalletTransaction.findOne({
    reference: transactionId,
    type:      'crossborder_payin',
    status:    { $in: ['pending', 'completed'] },
  }).session(session).lean()
  if (existing) {
    return {
      wtxId:        existing.wtxId,
      usdcAmount:   existing.amount,
      walletUSDCId: String(existing.walletId),
    }
  }

  const walletCheck = await WalletUSDC.findOne({ userId }).session(session).lean()
  if (!walletCheck)                     throw bizError(400, 'No tienes saldo USDC para pagar.', 'NO_USDC_WALLET')
  if (walletCheck.status !== 'active')  throw bizError(403, 'Tu wallet USDC no está activa. Contacta a soporte.', 'USDC_WALLET_INACTIVE')

  // Reserva atómica: verifica disponible (balance - reserved) en la misma operación
  // para prevenir double-spend por requests concurrentes.
  const wallet = await WalletUSDC.findOneAndUpdate(
    {
      _id:    walletCheck._id,
      status: 'active',
      $expr:  { $gte: [{ $subtract: ['$balance', { $ifNull: ['$balanceReserved', 0] }] }, amount] },
    },
    { $inc: { balanceReserved: amount } },
    { returnDocument: 'after', session },
  )
  if (!wallet) {
    const available = Math.max(0, walletCheck.balance - (walletCheck.balanceReserved ?? 0))
    throw bizError(400, `Saldo USDC insuficiente. Disponible: ${available.toFixed(6)} USDC.`, 'INSUFFICIENT_USDC')
  }

  const [wtx] = await WalletTransaction.create([{
    walletId:      wallet._id,
    walletModel:   'WalletUSDC',
    userId,
    currency:      'USDC',
    type:          'crossborder_payin',
    amount,
    balanceBefore: wallet.balance,
    balanceAfter:  wallet.balance,   // sin cambio hasta confirmar el débito
    status:        'pending',
    reference:     transactionId,
    description:   `Pago transfronterizo con saldo USDC: ${amount.toFixed(6)} USDC (${transactionId})`,
    metadata: {
      transactionId,
      corridorCode: corridorCode ?? null,
      bobPerUsdc:   bobPerUsdc ?? null,
      amountBOB:    amountBOB ?? null,
      usdcAmount:   amount,
      walletUSDCId: wallet._id.toString(),
    },
  }], { session })

  return { wtxId: wtx.wtxId, usdcAmount: amount, walletUSDCId: wallet._id.toString() }
}

/**
 * Confirma el débito: descuenta el saldo reservado del balance real. Se llama cuando el
 * payout se despachó/completó. Idempotente y atómico (guard pending→completed).
 *
 * @param {object} p
 * @param {string} p.transactionId
 * @param {import('mongoose').ClientSession} [p.session]  opcional; si falta, abre una propia
 * @returns {Promise<{ status: 'debited'|'noop', usdcAmount?: number }>}
 */
export async function confirmUSDCPayment({ transactionId, session } = {}) {
  if (!transactionId) throw bizError(400, 'transactionId es requerido.')

  return withSession(session, async (s) => {
    const wtx = await WalletTransaction.findOne({
      reference: transactionId,
      type:      'crossborder_payin',
    }).session(s)

    // Sin reserva registrada, o ya procesada → no-op idempotente.
    if (!wtx || wtx.status !== 'pending') return { status: 'noop' }

    const wallet = await WalletUSDC.findById(wtx.walletId).session(s)
    if (!wallet) throw bizError(404, 'WalletUSDC no encontrada para confirmar el débito.')

    const prevBalance = wallet.balance
    const newBalance  = round6(prevBalance - wtx.amount)

    // Guard atómico pending → completed (evita doble débito por confirmaciones concurrentes).
    const claim = await WalletTransaction.updateOne(
      { _id: wtx._id, status: 'pending' },
      { status: 'completed', balanceBefore: prevBalance, balanceAfter: newBalance, confirmedAt: new Date() },
      { session: s },
    )
    if (claim.modifiedCount === 0) return { status: 'noop' }

    // Debita balance y libera la reserva en una sola operación.
    await WalletUSDC.updateOne(
      { _id: wallet._id },
      { $inc: { balance: -wtx.amount, balanceReserved: -wtx.amount } },
      { session: s },
    )

    return { status: 'debited', usdcAmount: wtx.amount }
  })
}

/**
 * Libera la reserva sin debitar (rollback). Se llama cuando el payout falla, devolviendo
 * el saldo al usuario. Idempotente. NUNCA libera una reserva ya confirmada (débito real).
 *
 * @param {object} p
 * @param {string} p.transactionId
 * @param {string} [p.reason]
 * @param {import('mongoose').ClientSession} [p.session]
 * @returns {Promise<{ status: 'released'|'noop'|'already_debited', usdcAmount?: number }>}
 */
export async function releaseUSDCReservation({ transactionId, reason, session } = {}) {
  if (!transactionId) throw bizError(400, 'transactionId es requerido.')

  return withSession(session, async (s) => {
    const wtx = await WalletTransaction.findOne({
      reference: transactionId,
      type:      'crossborder_payin',
    }).session(s)

    if (!wtx)                        return { status: 'noop' }
    // El débito ya se confirmó: el payout consumió los fondos, no hay nada que liberar.
    if (wtx.status === 'completed')  return { status: 'already_debited' }
    if (wtx.status !== 'pending')    return { status: 'noop' }

    // Guard atómico pending → reversed.
    const claim = await WalletTransaction.updateOne(
      { _id: wtx._id, status: 'pending' },
      {
        status:   'reversed',
        metadata: { ...(wtx.metadata ?? {}), releaseReason: reason ?? 'payout_failed' },
      },
      { session: s },
    )
    if (claim.modifiedCount === 0) return { status: 'noop' }

    await WalletUSDC.updateOne(
      { _id: wtx.walletId },
      { $inc: { balanceReserved: -wtx.amount } },
      { session: s },
    )

    return { status: 'released', usdcAmount: wtx.amount }
  })
}

/**
 * Liquida la reserva de una transacción según su estado terminal:
 *   - 'completed'                       → confirma el débito.
 *   - 'failed' | 'refunded' | 'cancelled' → libera la reserva (rollback).
 *   - cualquier otro estado             → deja la reserva pendiente.
 *
 * Idempotente y seguro de llamar en cualquier transacción (no-op si no es walletUSDC).
 * Se invoca inline en las transiciones terminales del payout (Vita/Harbor) para
 * confirmar el débito al instante; el job `settleWalletPayins` es la red de seguridad.
 *
 * @param {object} transaction  documento (o lean) con paymentSource, status, alytoTransactionId
 */
export async function settleWalletPayinForTransaction(transaction) {
  if (!transaction || transaction.paymentSource !== 'walletUSDC') return { status: 'skip' }
  const transactionId = transaction.alytoTransactionId
  if (!transactionId) return { status: 'skip' }

  if (transaction.status === 'completed') {
    return confirmUSDCPayment({ transactionId })
  }
  if (RELEASE_STATUSES.has(transaction.status)) {
    return releaseUSDCReservation({ transactionId, reason: `payout_${transaction.status}` })
  }
  return { status: 'pending' }
}

/**
 * Red de seguridad: barre las reservas 'pending' de tipo 'crossborder_payin' y las liquida
 * contra el estado terminal de su transacción. Cubre cualquier transición terminal que no
 * haya disparado la liquidación inline (webhook perdido, reinicio, etc.).
 *
 * Pensado para correr periódicamente como job. Idempotente.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=200]  máximo de reservas a procesar por corrida
 * @returns {Promise<{ scanned: number, confirmed: number, released: number }>}
 */
export async function settleWalletPayins({ limit = 200 } = {}) {
  const pending = await WalletTransaction
    .find({ type: 'crossborder_payin', status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean()

  let confirmed = 0
  let released  = 0

  for (const wtx of pending) {
    const transactionId = wtx.reference
    if (!transactionId) continue
    try {
      const tx = await Transaction.findOne({ alytoTransactionId: transactionId })
        .select('status')
        .lean()
      if (!tx) continue

      if (tx.status === 'completed') {
        const r = await confirmUSDCPayment({ transactionId })
        if (r.status === 'debited') confirmed++
      } else if (RELEASE_STATUSES.has(tx.status)) {
        const r = await releaseUSDCReservation({ transactionId, reason: `reconcile_${tx.status}` })
        if (r.status === 'released') released++
      }
    } catch (err) {
      // Un fallo puntual no debe detener el barrido de las demás reservas.
      console.error('[walletPaymentService] settleWalletPayins error en', transactionId, '-', err.message)
    }
  }

  return { scanned: pending.length, confirmed, released }
}

export default {
  bobToUsdcDebit,
  reserveUSDCForPayment,
  confirmUSDCPayment,
  releaseUSDCReservation,
  settleWalletPayinForTransaction,
  settleWalletPayins,
}
