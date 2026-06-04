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
import WalletUSDC        from '../models/WalletUSDC.js'
import WalletBOB         from '../models/WalletBOB.js'
import WalletTransaction from '../models/WalletTransaction.js'
import User              from '../models/User.js'
import ExchangeRate      from '../models/ExchangeRate.js'
import Sentry            from '../services/sentry.js'
import { registerAuditTrail } from '../services/stellarService.js'
import { notify, notifyAdmins, NOTIFICATIONS } from '../services/notifications.js'
import { normalizeAlias } from './aliasController.js'

// Comisión P2P USDC — Camino USDC P2P. P1 arranca en 0; P3 la hace configurable.
// Mantener la firma para que el desglose pre-confirm exista desde el día 1.
function calcUsdcP2pFee(/* amount, accountType */) {
  return 0
}

// ─── Helper: obtener o crear WalletUSDC ──────────────────────────────────────

async function getOrCreateWalletUSDC(userId, session) {
  const opts = session ? { session } : {}
  let wallet = await WalletUSDC.findOne({ userId }, null, opts)
  if (!wallet) {
    // Camino A: la dirección de depósito es la cuenta custodial del PROPIO usuario
    // (Fase 38), NO la wallet de tesorería SRL compartida. Sin memo. Si el usuario
    // ya tiene keypair custodial se usa de inmediato; si no, se provisiona en el
    // flujo de instrucciones de depósito (ver getDepositInstructions).
    // ⚠️ No se provisiona aquí: esta función puede ejecutarse dentro de una sesión
    //    transaccional (convert-bob) y la provisión hace llamadas a Horizon.
    const owner            = await User.findById(userId, 'stellarAccount.publicKey', opts).lean()
    const custodialAddress = owner?.stellarAccount?.publicKey ?? null

    wallet = await WalletUSDC.create([{
      userId,
      stellarAddress: custodialAddress,
      stellarMemo:    null,
    }], opts)
    wallet = wallet[0]
  }
  return wallet
}

// ─── Helper: garantizar dirección de depósito custodial (Camino A) ───────────

/**
 * Devuelve la dirección Stellar custodial del usuario donde recibir USDC,
 * provisionando el keypair (Fase 38) si aún no existe. Fuera de toda sesión
 * transaccional — provisionUserKeypair hace llamadas a Horizon (fund + trustline).
 * @returns {Promise<{publicKey: string, usdcTrustline: boolean}>}
 */
async function ensureCustodialDepositAddress(userId) {
  let owner     = await User.findById(userId, 'stellarAccount.publicKey stellarAccount.activeTrustlines').lean()
  let publicKey = owner?.stellarAccount?.publicKey ?? null

  if (!publicKey) {
    const { provisionUserKeypair } = await import('../services/custodyService.js')
    const result = await provisionUserKeypair(userId)
    publicKey = result.publicKey
    owner = await User.findById(userId, 'stellarAccount.activeTrustlines').lean()
  }

  const usdcTrustline = Array.isArray(owner?.stellarAccount?.activeTrustlines)
    && owner.stellarAccount.activeTrustlines.includes('USDC')

  return { publicKey, usdcTrustline }
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
  // Usa getBOBUSDCRate: incluye el override admin BOB-USDC (margen manual)
  // solo para este corredor. getBOBRate (Vita/quotes) no incluye ese override.
  const { getBOBUSDCRate } = await import('../services/exchangeRateService.js')
  return getBOBUSDCRate()
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
 * Camino A: la dirección de depósito es la cuenta custodial del PROPIO usuario
 * (Fase 38). No se requiere memo — cada usuario tiene su dirección exclusiva, así
 * la wallet de tesorería SRL deja de recibir depósitos de usuarios. El keypair se
 * provisiona on-demand si aún no existe. La dirección almacenada se sincroniza
 * (lazy-migración de wallets legacy con memo sobre la dirección compartida).
 */
export async function getDepositInstructions(req, res) {
  try {
    const user = req.user
    if (user.legalEntity !== 'SRL') {
      return res.status(403).json({ error: 'Exclusivo para usuarios Bolivia (SRL).' })
    }

    const wallet = await getOrCreateWalletUSDC(user._id)

    // Dirección de depósito = cuenta custodial propia (provisiona si falta)
    const { publicKey: custodialAddress, usdcTrustline } = await ensureCustodialDepositAddress(user._id)

    // Sincronizar la dirección almacenada si cambió (lazy-migración legacy → custodial)
    if (custodialAddress && (wallet.stellarAddress !== custodialAddress || wallet.stellarMemo)) {
      await WalletUSDC.updateOne(
        { _id: wallet._id },
        { stellarAddress: custodialAddress, stellarMemo: null },
      )
    }

    const USDC_ISSUER = process.env.STELLAR_USDC_ISSUER
      ?? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

    return res.json({
      network:        process.env.STELLAR_NETWORK ?? 'testnet',
      stellarAddress: custodialAddress,
      stellarMemo:    null,            // Camino A: sin memo — dirección exclusiva por usuario
      memoRequired:   false,
      asset:          'USDC',
      assetIssuer:    USDC_ISSUER,
      ready:          usdcTrustline,   // si false, la trustline USDC aún se está estableciendo
      warning:        usdcTrustline
        ? 'Envía USDC (red Stellar) únicamente a tu dirección. No necesitas memo.'
        : 'Tu cuenta Stellar se está preparando para recibir USDC (estableciendo trustline). Reintenta en unos minutos antes de depositar.',
      instructions:   [
        `1. Envía USDC (red Stellar) a tu dirección: ${custodialAddress}`,
        '2. No se requiere memo — la dirección es exclusivamente tuya.',
        '3. El depósito se acreditará automáticamente al confirmarse en la red Stellar.',
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

    // Verificar wallet BOB activa
    const walletBOBCheck = await WalletBOB.findOne({ userId: user._id }).session(session).lean()
    if (!walletBOBCheck) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'No tienes una wallet BOB activa. Deposita primero.' })
    }
    if (walletBOBCheck.status !== 'active') {
      await session.abortTransaction()
      return res.status(403).json({ error: 'Tu wallet BOB no está activa. Contacta a soporte.' })
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

    // Reservar el monto BOB atómicamente — verifica saldo disponible en la misma operación
    // para prevenir double-spend por requests concurrentes del mismo usuario.
    const walletBOB = await WalletBOB.findOneAndUpdate(
      {
        _id:    walletBOBCheck._id,
        status: 'active',
        $expr:  { $gte: [{ $subtract: ['$balance', '$balanceReserved'] }, amount] },
      },
      { $inc: { balanceReserved: amount } },
      { returnDocument: 'after', session },
    )
    if (!walletBOB) {
      const available = Math.max(0, walletBOBCheck.balance - walletBOBCheck.balanceReserved)
      await session.abortTransaction()
      return res.status(400).json({ error: `Saldo BOB insuficiente. Disponible: Bs. ${available.toFixed(2)}.` })
    }

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

    // Notificar a admins — push + in-app
    const fullName = `${user.firstName} ${user.lastName}`.trim();
    notifyAdmins(NOTIFICATIONS.adminConversionRequest(amount, usdcAmount, fullName)).catch(() => {});

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

// ─── FUNCIÓN: GET /api/v1/wallet/usdc/rate ────────────────────────────────────

/**
 * Devuelve el tipo de cambio BOB/USDC actual sin ejecutar ninguna conversión.
 * Usado por el frontend para mostrar el preview "100 BOB ≈ X USDC".
 *
 * Response: { bobPerUsdc: number, source: string, updatedAt: ISO }
 */
export async function getUSDCRate(req, res) {
  try {
    const { getBOBUSDCRate } = await import('../services/exchangeRateService.js')

    // Buscar el record para exponer source y updatedAt al frontend
    const rateDoc = await ExchangeRate.findOne({
      pair: { $in: ['BOB-USDC', 'BOB/USDC', 'BOB-USDT', 'BOB-USD'] },
    }).sort({ updatedAt: -1 }).lean()

    const rate      = await getBOBUSDCRate()
    const source    = rateDoc ? rateDoc.source ?? 'manual' : 'env_fallback'
    const updatedAt = rateDoc?.updatedAt ?? null

    // `rate` es alias de `bobPerUsdc` por compatibilidad con clientes que leen
    // cualquiera de las dos claves (evita "Cargando tasa..." si el frontend
    // desplegado aún espera `rate`).
    return res.json({ bobPerUsdc: rate, rate, source, updatedAt })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletUSDCController', fn: 'getUSDCRate' } })
    console.error('[WalletUSDC] Error en getUSDCRate:', err.message)
    return res.status(500).json({ error: 'Error al obtener el tipo de cambio.' })
  }
}

// ─── Helper: resolver destinatario por alias ─────────────────────────────────

async function resolveRecipientByAlias(rawAlias) {
  const alias = normalizeAlias(rawAlias)
  if (!alias) return { error: 'Falta el alias del destinatario.' }
  const recipient = await User.findOne({ alytoAlias: alias })
    .select('_id firstName lastName legalEntity alytoAlias').lean()
  if (!recipient) return { error: 'No existe un usuario Alyto con ese alias.' }
  if (recipient.legalEntity !== 'SRL') return { error: 'Solo podés enviar a otros usuarios Bolivia (SRL).' }
  return { recipient }
}

// ─── GET /api/v1/wallet/usdc/transfer-quote ──────────────────────────────────

/**
 * Previsualiza una transferencia USDC P2P: resuelve el destinatario por alias y
 * devuelve el desglose (monto, comisión, total). La comisión hoy es 0 (P1).
 * Query: alias, amount
 */
export async function getUSDCTransferQuote(req, res) {
  try {
    const user = req.user
    if (user.legalEntity !== 'SRL') {
      return res.status(403).json({ error: 'Exclusivo para usuarios Bolivia (SRL).' })
    }
    const amount = Number(req.query.amount)
    const { recipient, error } = await resolveRecipientByAlias(req.query.alias)
    if (error) return res.status(404).json({ error })
    if (String(recipient._id) === String(user._id)) {
      return res.status(400).json({ error: 'No podés enviarte USDC a vos mismo.' })
    }

    const validAmount = Number.isFinite(amount) && amount > 0
    const fee   = validAmount ? calcUsdcP2pFee(amount, user.accountType) : 0
    const total = validAmount ? amount + fee : 0

    return res.json({
      recipient: {
        alias: recipient.alytoAlias,
        name:  `${recipient.firstName ?? ''} ${recipient.lastName ?? ''}`.trim(),
      },
      currency: 'USDC',
      amount:   validAmount ? amount : null,
      fee,
      total,
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletUSDCController', fn: 'getUSDCTransferQuote' } })
    console.error('[WalletUSDC] Error en getUSDCTransferQuote:', err.message)
    return res.status(500).json({ error: 'Error al previsualizar la transferencia.' })
  }
}

// ─── POST /api/v1/wallet/usdc/send ───────────────────────────────────────────

/**
 * Transferencia USDC P2P entre wallets Alyto (ledger-only + audit trail).
 * Body: { recipientAlias, amount, description? }
 * Modelo custodial: ambas wallets son de Alyto → se reasigna saldo en el libro
 * (sesión atómica), sin movimiento on-chain. Preserva la colateralización.
 * Comisión: 0 en P1 (estructura lista para P3).
 */
export async function sendUSDC(req, res) {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const sender = req.user
    const { recipientAlias, amount: rawAmount, description } = req.body
    const amount = Number(rawAmount)

    if (sender.legalEntity !== 'SRL') {
      await session.abortTransaction()
      return res.status(403).json({ error: 'La wallet USDC es exclusiva para usuarios Bolivia (SRL).' })
    }
    if (!recipientAlias || !Number.isFinite(amount) || amount <= 0) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'recipientAlias y amount (> 0) son requeridos.' })
    }
    if (amount < 1) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'El monto mínimo de envío es 1 USDC.' })
    }

    const { recipient, error } = await resolveRecipientByAlias(recipientAlias)
    if (error) {
      await session.abortTransaction()
      return res.status(404).json({ error })
    }
    if (String(recipient._id) === String(sender._id)) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'No podés enviarte USDC a vos mismo.' })
    }

    const fee   = calcUsdcP2pFee(amount, sender.accountType)
    const total = amount + fee

    // Secuencial — MongoDB no permite operaciones concurrentes en la misma sesión
    const walletOrigen  = await getOrCreateWalletUSDC(sender._id, session)
    const walletDestino = await getOrCreateWalletUSDC(recipient._id, session)

    if (walletOrigen.status !== 'active') {
      await session.abortTransaction()
      return res.status(403).json({ error: 'Tu wallet USDC no está activa.' })
    }
    if (walletDestino.status !== 'active') {
      await session.abortTransaction()
      return res.status(400).json({ error: 'La wallet USDC del destinatario no está activa.' })
    }

    const balanceAvailable = Math.max(0, walletOrigen.balance - walletOrigen.balanceReserved)
    if (balanceAvailable < total) {
      await session.abortTransaction()
      return res.status(400).json({ error: `Saldo USDC insuficiente. Disponible: ${balanceAvailable.toFixed(2)} USDC (necesitás ${total.toFixed(2)}).` })
    }

    const prevOrigen  = walletOrigen.balance
    const prevDestino = walletDestino.balance

    await WalletUSDC.updateOne({ _id: walletOrigen._id },  { $inc: { balance: -total }  }, { session })
    await WalletUSDC.updateOne({ _id: walletDestino._id }, { $inc: { balance:  amount } }, { session })

    const recipientName = `${recipient.firstName ?? ''} ${recipient.lastName ?? ''}`.trim()
    const senderName    = `${sender.firstName ?? ''} ${sender.lastName ?? ''}`.trim()

    const [wtxSend, wtxReceive] = await WalletTransaction.create([
      {
        walletId:           walletOrigen._id,
        walletModel:        'WalletUSDC',
        userId:             sender._id,
        type:               'send',
        currency:           'USDC',
        amount,
        balanceBefore:      prevOrigen,
        balanceAfter:       prevOrigen - total,
        status:             'completed',
        description:        description ?? `Envío USDC a @${recipient.alytoAlias}`,
        counterpartyUserId: recipient._id,
        confirmedAt:        new Date(),
        metadata:           { recipientAlias: recipient.alytoAlias, fee },
      },
      {
        walletId:           walletDestino._id,
        walletModel:        'WalletUSDC',
        userId:             recipient._id,
        type:               'receive',
        currency:           'USDC',
        amount,
        balanceBefore:      prevDestino,
        balanceAfter:       prevDestino + amount,
        status:             'completed',
        description:        `USDC recibido de ${senderName}`,
        counterpartyUserId: sender._id,
        confirmedAt:        new Date(),
        metadata:           { senderAlias: sender.alytoAlias ?? null },
      },
    ], { session, ordered: true })

    await session.commitTransaction()

    // Audit trail Stellar — fire and forget (memo, no envío on-chain)
    fireUSDCAuditTrail(wtxSend.wtxId)

    // Notificaciones — fire and forget
    notify(recipient._id, NOTIFICATIONS.usdcReceived(amount, senderName)).catch(() => {})
    notifyAdmins(NOTIFICATIONS.adminUsdcP2pTransfer(amount, senderName, recipientName)).catch(() => {})

    return res.json({
      wtxId:        wtxSend.wtxId,
      amount,
      fee,
      total,
      recipient:    { alias: recipient.alytoAlias, name: recipientName },
      balanceAfter: prevOrigen - total,
    })

  } catch (err) {
    await session.abortTransaction()
    Sentry.captureException(err, { tags: { controller: 'walletUSDCController', fn: 'sendUSDC' } })
    console.error('[WalletUSDC] Error en sendUSDC:', err.message)
    return res.status(500).json({ error: 'Error al procesar la transferencia USDC.' })
  } finally {
    session.endSession()
  }
}
