/**
 * walletUSDCController.js — Wallet con Saldo USDC (Fase 35)
 *
 * Exclusivo para usuarios legalEntity === 'SRL' (Bolivia).
 * No afecta flujos de Chile (SpA) ni institucional (LLC).
 *
 * Arquitectura Dual Ledger:
 *   - Todas las operaciones monetarias son atómicas (mongoose sessions)
 *   - El audit trail Stellar es fire-and-forget — nunca bloquea el flujo
 *
 * Endpoints usuario:
 *   GET  /api/v1/wallet/usdc/balance
 *   GET  /api/v1/wallet/usdc/deposit-instructions
 *   POST /api/v1/wallet/usdc/convert-bob
 *
 * Endpoints admin (en adminController / adminRoutes):
 *   GET  /api/v1/admin/wallet/usdc/conversions/pending
 *   POST /api/v1/admin/wallet/usdc/conversions/confirm
 *   POST /api/v1/admin/wallet/usdc/conversions/reject
 */

import mongoose          from 'mongoose'
import crypto            from 'crypto'
import WalletUSDC        from '../models/WalletUSDC.js'
import WalletBOB         from '../models/WalletBOB.js'
import WalletTransaction from '../models/WalletTransaction.js'
import ExchangeRate      from '../models/ExchangeRate.js'
import Sentry            from '../services/sentry.js'
import { registerAuditTrail } from '../services/stellarService.js'
import { notify, NOTIFICATIONS } from '../services/notifications.js'

// ─── Helper: generar memo único ───────────────────────────────────────────────

function generateStellarMemo() {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase()
  return `ALYTO-${rand}`
}

// ─── Helper: obtener o crear WalletUSDC ──────────────────────────────────────

async function getOrCreateWalletUSDC(userId, session) {
  const opts = session ? { session } : {}
  let wallet = await WalletUSDC.findOne({ userId }, null, opts)
  if (!wallet) {
    // Asignar la dirección Stellar compartida SRL y generar memo único
    const stellarAddress = process.env.STELLAR_SRL_PUBLIC_KEY ?? null
    const stellarMemo    = generateStellarMemo()

    wallet = await WalletUSDC.create([{
      userId,
      stellarAddress,
      stellarMemo,
    }], opts)
    wallet = wallet[0]
  }
  return wallet
}

// ─── Helper: fire-and-forget audit trail USDC ────────────────────────────────

function fireUSDCAuditTrail(wtxId) {
  const fakeDoc = {
    alytoTransactionId: wtxId,
    legalEntity: 'SRL',
  }
  registerAuditTrail(fakeDoc)
    .then(hash => {
      if (hash) {
        WalletTransaction.updateOne({ wtxId }, { stellarTxId: hash }).catch(() => {})
      }
    })
    .catch(() => {})
}

// ─── Helper: obtener tasa BOB/USDC ────────────────────────────────────────────

async function getBOBtoUSDCRate() {
  // Intentar leer de MongoDB (par 'BOB-USDC' o 'BOB-USDT' como proxy)
  const rateDoc = await ExchangeRate.findOne({ pair: { $in: ['BOB-USDC', 'BOB-USDT'] } })
    .sort({ pair: 1 })  // BOB-USDC preferido sobre BOB-USDT
    .lean()

  if (rateDoc?.rate && rateDoc.rate > 0) return rateDoc.rate

  // Fallback a variable de entorno
  const envRate = parseFloat(process.env.BOB_USD_RATE ?? '9.31')
  return isNaN(envRate) ? 9.31 : envRate
}

// ─── FUNCIÓN 1: GET /api/v1/wallet/usdc/balance ───────────────────────────────

/**
 * Retorna el saldo USDC actual del usuario.
 * Crea la WalletUSDC si es la primera vez que el usuario SRL la consulta.
 */
export async function getUSDCBalance(req, res) {
  try {
    const user = req.user
    if (user.legalEntity !== 'SRL') {
      return res.status(403).json({ error: 'La wallet USDC es exclusiva para usuarios Bolivia (SRL).' })
    }

    const wallet = await getOrCreateWalletUSDC(user._id)

    return res.json({
      walletId:         wallet.walletId,
      currency:         'USDC',
      balance:          wallet.balance,
      balanceFrozen:    wallet.balanceFrozen,
      balanceReserved:  wallet.balanceReserved,
      balanceAvailable: Math.max(0, wallet.balance - wallet.balanceReserved),
      stellarAddress:   wallet.stellarAddress,
      stellarMemo:      wallet.stellarMemo,
      status:           wallet.status,
    })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletUSDCController', fn: 'getUSDCBalance' } })
    console.error('[WalletUSDC] Error en getUSDCBalance:', err.message)
    return res.status(500).json({ error: 'Error al obtener saldo USDC.' })
  }
}

// ─── FUNCIÓN 2: GET /api/v1/wallet/usdc/deposit-instructions ─────────────────

/**
 * Retorna las instrucciones para depositar USDC directamente vía Stellar.
 * No requiere monto — el usuario puede depositar cualquier cantidad.
 *
 * ⚠️ El usuario DEBE incluir el stellarMemo exacto para que el depósito
 * sea identificado y acreditado correctamente.
 */
export async function getDepositInstructions(req, res) {
  try {
    const user = req.user
    if (user.legalEntity !== 'SRL') {
      return res.status(403).json({ error: 'Exclusivo para usuarios Bolivia (SRL).' })
    }

    const wallet = await getOrCreateWalletUSDC(user._id)

    const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

    return res.json({
      network:          process.env.STELLAR_NETWORK ?? 'testnet',
      stellarAddress:   wallet.stellarAddress,
      stellarMemo:      wallet.stellarMemo,
      memoType:         'text',
      asset:            'USDC',
      assetIssuer:      USDC_ISSUER,
      warning:          'IMPORTANTE: Debes incluir el memo exacto al realizar la transferencia. Sin memo el depósito no podrá ser acreditado.',
      instructions:     [
        `1. Envía USDC a la dirección: ${wallet.stellarAddress}`,
        `2. Incluye el memo (texto): ${wallet.stellarMemo}`,
        '3. El equipo Alyto verificará y acreditará tu saldo en 1-2 horas hábiles.',
      ],
    })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletUSDCController', fn: 'getDepositInstructions' } })
    console.error('[WalletUSDC] Error en getDepositInstructions:', err.message)
    return res.status(500).json({ error: 'Error al obtener instrucciones de depósito.' })
  }
}

// ─── FUNCIÓN 3: POST /api/v1/wallet/usdc/convert-bob ─────────────────────────

/**
 * Solicita conversión de BOB → USDC.
 *
 * Flujo:
 *   1. Valida que el usuario SRL tenga suficiente saldo BOB disponible.
 *   2. Reserva el monto BOB (balanceReserved += amount).
 *   3. Crea un WalletTransaction pending tipo 'bob_to_usdc'.
 *   4. El admin confirma manualmente en /api/v1/admin/wallet/usdc/conversions/confirm.
 *
 * Body: { amount: number } — monto en BOB a convertir
 */
export async function requestBOBtoUSDC(req, res) {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const user        = req.user
    const amount      = Number(req.body.amount)
    const MIN_CONVERT = 50   // Bs. mínimo para conversión

    if (user.legalEntity !== 'SRL') {
      await session.abortTransaction()
      return res.status(403).json({ error: 'La conversión BOB→USDC es exclusiva para usuarios Bolivia (SRL).' })
    }
    if (user.kycStatus !== 'approved') {
      await session.abortTransaction()
      return res.status(403).json({ error: 'Debes completar la verificación de identidad (KYC) para convertir fondos.' })
    }
    if (!amount || isNaN(amount) || amount <= 0) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'El campo amount es requerido y debe ser mayor a 0.' })
    }
    if (amount < MIN_CONVERT) {
      await session.abortTransaction()
      return res.status(400).json({ error: `El monto mínimo de conversión es Bs. ${MIN_CONVERT}.` })
    }

    // Verificar saldo BOB disponible
    const walletBOB = await WalletBOB.findOne({ userId: user._id }).session(session)
    if (!walletBOB) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'No tienes una wallet BOB activa. Deposita primero.' })
    }
    if (walletBOB.status !== 'active') {
      await session.abortTransaction()
      return res.status(403).json({ error: 'Tu wallet BOB no está activa. Contacta a soporte.' })
    }
    const balanceBOBAvailable = Math.max(0, walletBOB.balance - walletBOB.balanceReserved)
    if (balanceBOBAvailable < amount) {
      await session.abortTransaction()
      return res.status(400).json({ error: `Saldo BOB insuficiente. Disponible: Bs. ${balanceBOBAvailable.toFixed(2)}.` })
    }

    // Obtener tasa de cambio BOB/USDC
    const bobPerUsdc  = await getBOBtoUSDCRate()
    const usdcAmount  = parseFloat((amount / bobPerUsdc).toFixed(6))

    // Obtener o crear WalletUSDC (por si es la primera vez)
    const walletUSDC = await getOrCreateWalletUSDC(user._id, session)
    if (walletUSDC.status !== 'active') {
      await session.abortTransaction()
      return res.status(403).json({ error: 'Tu wallet USDC no está activa. Contacta a soporte.' })
    }

    // Reservar el monto BOB (no se descuenta aún — solo se reserva)
    await WalletBOB.updateOne(
      { _id: walletBOB._id },
      { $inc: { balanceReserved: amount } },
      { session }
    )

    // Crear WalletTransaction pending
    const [wtx] = await WalletTransaction.create([{
      walletId:     walletBOB._id,
      walletModel:  'WalletBOB',
      userId:       user._id,
      currency:     'BOB',
      type:         'bob_to_usdc',
      amount,
      balanceBefore: walletBOB.balance,
      balanceAfter:  walletBOB.balance,  // se actualiza cuando admin confirme
      status:        'pending',
      description:   `Conversión BOB→USDC: Bs. ${amount.toFixed(2)} → ${usdcAmount.toFixed(6)} USDC`,
      metadata: {
        bobAmount:   amount,
        usdcAmount,
        bobPerUsdc,
        walletUSDCId: walletUSDC._id.toString(),
        walletBOBId:  walletBOB._id.toString(),
      },
    }], { session })

    await session.commitTransaction()

    return res.status(201).json({
      wtxId:       wtx.wtxId,
      bobAmount:   amount,
      usdcAmount,
      bobPerUsdc,
      status:      'pending',
      message:     'Solicitud de conversión recibida. El equipo Alyto procesará la conversión en 1-4 horas hábiles.',
    })

  } catch (err) {
    await session.abortTransaction()
    Sentry.captureException(err, { tags: { controller: 'walletUSDCController', fn: 'requestBOBtoUSDC' } })
    console.error('[WalletUSDC] Error en requestBOBtoUSDC:', err.message)
    return res.status(500).json({ error: 'Error al procesar la solicitud de conversión.' })
  } finally {
    session.endSession()
  }
}

// ─── FUNCIÓN 4 (ADMIN): POST /api/v1/admin/wallet/usdc/conversions/confirm ───

/**
 * Admin confirma la conversión BOB → USDC.
 * Operación atómica:
 *   1. Debita BOB.balance y libera BOB.balanceReserved
 *   2. Acredita USDC.balance
 *   3. Actualiza WalletTransaction a 'completed'
 *   4. Crea WalletTransaction de tipo 'usdc_deposit' en WalletUSDC
 *   5. Fire-and-forget: Stellar audit trail
 *
 * Body: { wtxId, note? }
 */
export async function adminConfirmBOBtoUSDC(req, res) {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const admin = req.user
    const { wtxId, note } = req.body

    if (!wtxId) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'wtxId es requerido.' })
    }

    const wtx = await WalletTransaction.findOne({ wtxId }).session(session)
    if (!wtx) {
      await session.abortTransaction()
      return res.status(404).json({ error: 'Transacción no encontrada.' })
    }
    if (wtx.type !== 'bob_to_usdc') {
      await session.abortTransaction()
      return res.status(400).json({ error: 'La transacción no es una conversión BOB→USDC.' })
    }
    if (wtx.status !== 'pending') {
      await session.abortTransaction()
      return res.status(400).json({ error: `La conversión ya fue procesada (status: ${wtx.status}).` })
    }

    const { bobAmount, usdcAmount, walletUSDCId, walletBOBId } = wtx.metadata ?? {}

    if (!bobAmount || !usdcAmount || !walletUSDCId || !walletBOBId) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'Metadata de conversión incompleta. No se puede procesar.' })
    }

    const walletBOB  = await WalletBOB.findById(walletBOBId).session(session)
    const walletUSDC = await WalletUSDC.findById(walletUSDCId).session(session)

    if (!walletBOB) {
      await session.abortTransaction()
      return res.status(404).json({ error: 'WalletBOB no encontrada.' })
    }
    if (!walletUSDC) {
      await session.abortTransaction()
      return res.status(404).json({ error: 'WalletUSDC no encontrada.' })
    }

    const now              = new Date()
    const prevBalanceBOB   = walletBOB.balance
    const newBalanceBOB    = prevBalanceBOB - bobAmount
    const prevBalanceUSDC  = walletUSDC.balance
    const newBalanceUSDC   = prevBalanceUSDC + usdcAmount

    // 1. Debitar BOB y liberar reserva
    await WalletBOB.updateOne({ _id: walletBOB._id }, {
      $inc: { balance: -bobAmount, balanceReserved: -bobAmount },
    }, { session })

    // 2. Acreditar USDC
    await WalletUSDC.updateOne({ _id: walletUSDC._id }, {
      $inc: { balance: usdcAmount },
    }, { session })

    // 3. Actualizar WalletTransaction BOB a 'completed'
    await WalletTransaction.updateOne({ _id: wtx._id }, {
      status:        'completed',
      balanceBefore: prevBalanceBOB,
      balanceAfter:  newBalanceBOB,
      confirmedBy:   admin._id,
      confirmedAt:   now,
      metadata:      { ...(wtx.metadata ?? {}), note: note ?? '', confirmedBy: admin._id },
    }, { session })

    // 4. Crear WalletTransaction de crédito en WalletUSDC
    const [wtxUSDC] = await WalletTransaction.create([{
      walletId:      walletUSDC._id,
      walletModel:   'WalletUSDC',
      userId:        wtx.userId,
      currency:      'USDC',
      type:          'usdc_deposit',
      amount:        usdcAmount,
      balanceBefore: prevBalanceUSDC,
      balanceAfter:  newBalanceUSDC,
      status:        'completed',
      description:   `Conversión BOB→USDC confirmada: ${bobAmount.toFixed(2)} BOB → ${usdcAmount.toFixed(6)} USDC`,
      confirmedBy:   admin._id,
      confirmedAt:   now,
      metadata: {
        sourceBOBWtxId: wtxId,
        bobAmount,
        bobPerUsdc:     wtx.metadata?.bobPerUsdc,
      },
    }], { session })

    await session.commitTransaction()

    // 5. Audit trail Stellar — fire and forget
    fireUSDCAuditTrail(wtxUSDC.wtxId)

    // 6. Notificación al usuario
    notify(wtx.userId, NOTIFICATIONS.conversionConfirmed(bobAmount, usdcAmount)).catch(() => {})

    return res.json({
      wtxId,
      wtxUSDCId:     wtxUSDC.wtxId,
      bobDebited:    bobAmount,
      usdcCredited:  usdcAmount,
      newBalanceBOB,
      newBalanceUSDC,
      confirmedAt:   now,
    })

  } catch (err) {
    await session.abortTransaction()
    Sentry.captureException(err, { tags: { controller: 'walletUSDCController', fn: 'adminConfirmBOBtoUSDC' } })
    console.error('[WalletUSDC] Error en adminConfirmBOBtoUSDC:', err.message)
    return res.status(500).json({ error: 'Error al confirmar la conversión.' })
  } finally {
    session.endSession()
  }
}

// ─── FUNCIÓN 5 (ADMIN): GET /api/v1/admin/wallet/usdc/conversions/pending ────

/**
 * Lista conversiones BOB→USDC pendientes de confirmación.
 */
export async function adminListPendingConversions(req, res) {
  try {
    const pending = await WalletTransaction.find({ type: 'bob_to_usdc', status: 'pending' })
      .sort({ createdAt: -1 })
      .populate('userId', 'firstName lastName email kycStatus')
      .lean()

    return res.json({ conversions: pending, total: pending.length })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletUSDCController', fn: 'adminListPendingConversions' } })
    console.error('[WalletUSDC] Error en adminListPendingConversions:', err.message)
    return res.status(500).json({ error: 'Error al listar conversiones pendientes.' })
  }
}

// ─── FUNCIÓN 6 (ADMIN): POST /api/v1/admin/wallet/usdc/conversions/reject ────

/**
 * Admin rechaza una conversión BOB→USDC pendiente.
 * Operación atómica:
 *   1. Libera BOB.balanceReserved
 *   2. Marca WalletTransaction como 'failed' con razón de rechazo
 *   3. Fire-and-forget: audit trail + notificación push al usuario
 *
 * Body: { wtxId, rejectReason? }
 */
export async function adminRejectBOBtoUSDC(req, res) {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const admin = req.user
    const { wtxId, rejectReason } = req.body

    if (!wtxId) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'wtxId es requerido.' })
    }

    const wtx = await WalletTransaction.findOne({ wtxId }).session(session)
    if (!wtx) {
      await session.abortTransaction()
      return res.status(404).json({ error: 'Transacción no encontrada.' })
    }
    if (wtx.type !== 'bob_to_usdc') {
      await session.abortTransaction()
      return res.status(400).json({ error: 'La transacción no es una conversión BOB→USDC.' })
    }
    if (wtx.status !== 'pending') {
      await session.abortTransaction()
      return res.status(400).json({ error: `La conversión ya fue procesada (status: ${wtx.status}).` })
    }

    const { bobAmount, walletBOBId } = wtx.metadata ?? {}

    if (!bobAmount || !walletBOBId) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'Metadata de conversión incompleta.' })
    }

    const walletBOB = await WalletBOB.findById(walletBOBId).session(session)
    if (!walletBOB) {
      await session.abortTransaction()
      return res.status(404).json({ error: 'WalletBOB no encontrada.' })
    }

    const now = new Date()

    // 1. Liberar reserva — devolver BOB al saldo disponible
    await WalletBOB.updateOne({ _id: walletBOB._id }, {
      $inc: { balanceReserved: -bobAmount },
    }, { session })

    // 2. Marcar WalletTransaction como failed (rechazada)
    await WalletTransaction.updateOne({ _id: wtx._id }, {
      status:   'failed',
      metadata: {
        ...(wtx.metadata ?? {}),
        rejectReason: rejectReason ?? '',
        rejectedBy:   admin._id,
        rejectedAt:   now,
      },
    }, { session })

    await session.commitTransaction()

    // 3. Audit trail Stellar — fire and forget
    fireUSDCAuditTrail(wtxId)

    // 4. Notificación al usuario
    notify(wtx.userId, NOTIFICATIONS.conversionRejected(bobAmount, rejectReason ?? '')).catch(() => {})

    return res.json({
      wtxId,
      status:       'failed',
      bobReleased:  bobAmount,
      rejectReason: rejectReason ?? '',
      rejectedAt:   now,
    })

  } catch (err) {
    await session.abortTransaction()
    Sentry.captureException(err, { tags: { controller: 'walletUSDCController', fn: 'adminRejectBOBtoUSDC' } })
    console.error('[WalletUSDC] Error en adminRejectBOBtoUSDC:', err.message)
    return res.status(500).json({ error: 'Error al rechazar la conversión.' })
  } finally {
    session.endSession()
  }
}

// ─── FUNCIÓN 7: GET /api/v1/wallet/usdc/transactions ─────────────────────────

/**
 * Historial paginado de movimientos USDC del usuario.
 */
export async function getUSDCTransactions(req, res) {
  try {
    const user = req.user
    if (user.legalEntity !== 'SRL') {
      return res.status(403).json({ error: 'Exclusivo para usuarios Bolivia (SRL).' })
    }

    const page  = Math.max(1, parseInt(req.query.page  ?? '1', 10))
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? '20', 10)))
    const skip  = (page - 1) * limit

    const walletUSDC = await WalletUSDC.findOne({ userId: user._id }).lean()
    if (!walletUSDC) {
      return res.json({ transactions: [], pagination: { page, limit, total: 0, totalPages: 0 } })
    }

    const filter = {
      walletId:    walletUSDC._id,
      walletModel: 'WalletUSDC',
    }
    if (req.query.type)   filter.type   = req.query.type
    if (req.query.status) filter.status = req.query.status

    const [transactions, total] = await Promise.all([
      WalletTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      WalletTransaction.countDocuments(filter),
    ])

    return res.json({
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletUSDCController', fn: 'getUSDCTransactions' } })
    console.error('[WalletUSDC] Error en getUSDCTransactions:', err.message)
    return res.status(500).json({ error: 'Error al obtener historial USDC.' })
  }
}
