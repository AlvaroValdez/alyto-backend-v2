/**
 * walletController.js — Wallet con Saldo BOB (Dual Ledger Bolivia)
 *
 * Fase 25 — Exclusivo para usuarios legalEntity === 'SRL'.
 * No afecta flujos de Chile (SpA) ni institucional (LLC).
 *
 * Arquitectura:
 *   - Todas las operaciones monetarias son atómicas (mongoose sessions)
 *   - El audit trail Stellar es fire-and-forget — nunca bloquea el flujo
 *   - Errors capturados por Sentry con contexto
 *
 * Endpoints usuario:
 *   GET  /api/v1/wallet/balance
 *   GET  /api/v1/wallet/transactions
 *   POST /api/v1/wallet/deposit/initiate
 *   POST /api/v1/wallet/send
 *   POST /api/v1/wallet/withdraw/request
 *
 * Endpoints admin (montados en /api/v1/admin/wallet/*):
 *   POST  /api/v1/admin/wallet/deposit/confirm
 *   GET   /api/v1/admin/wallet
 *   GET   /api/v1/admin/wallet/deposits/pending
 *   PATCH /api/v1/admin/wallet/:userId/freeze
 *   PATCH /api/v1/admin/wallet/:userId/unfreeze
 */

import mongoose         from 'mongoose'
import WalletBOB        from '../models/WalletBOB.js'
import WalletTransaction from '../models/WalletTransaction.js'
import User             from '../models/User.js'
import BusinessProfile  from '../models/BusinessProfile.js'
import ExchangeRate     from '../models/ExchangeRate.js'
import Sentry           from '../services/sentry.js'
import { sendEmail, EMAILS } from '../services/email.js'
import { notify, notifyAdmins, NOTIFICATIONS } from '../services/notifications.js'
import { registerAuditTrail, freezeUserTrustline, unfreezeUserTrustline } from '../services/stellarService.js'
import { getBankQrService } from '../services/bankQr/bankQrRegistry.js'

// ─── Config: payin bankQr para carga de Wallet BOB ────────────────────────────

/**
 * Lee el gate de payin automático por QR bancario para la carga de Wallet BOB.
 * Por entorno (env): staging puede activarlo con mock mode; prod queda OFF hasta
 * tener credenciales BEC reales registradas.
 *
 * @returns {{ enabled: boolean, bankId: string }}
 */
export function getWalletDepositBankQrConfig() {
  return {
    enabled: String(process.env.WALLET_DEPOSIT_BANKQR_ENABLED).toLowerCase() === 'true',
    bankId:  process.env.WALLET_DEPOSIT_BANK_ID ?? 'bec',
  }
}

// ─── Helper interno ───────────────────────────────────────────────────────────

/**
 * Obtiene la WalletBOB del usuario, creándola si no existe.
 * Solo para usuarios SRL — no valida la entidad aquí (se valida en cada endpoint).
 *
 * @param {mongoose.Types.ObjectId|string} userId
 * @param {mongoose.ClientSession} [session]
 * @returns {Promise<WalletBOB>}
 */
export async function getOrCreateWallet(userId, session) {
  const opts = session ? { session } : {}
  let wallet = await WalletBOB.findOne({ userId }, null, opts)
  if (!wallet) {
    wallet = await WalletBOB.create([{ userId }], opts)
    wallet = wallet[0]
  }
  return wallet
}

/**
 * Registra el audit trail en Stellar de forma asíncrona (fire-and-forget).
 * Nunca bloquea el flujo principal ni lanza excepciones.
 *
 * @param {string} wtxId       — ID de la WalletTransaction
 * @param {string} type        — tipo de operación ('deposit', 'send', etc.)
 * @param {number} amount      — monto en BOB
 * @param {string} [reference] — referencia adicional
 */
export function fireAuditTrail(wtxId, type, amount, reference = '') {
  // Construimos un objeto compatible con registerAuditTrail
  const fakeDoc = {
    alytoTransactionId: `${wtxId}`,
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

// ─── FUNCIÓN 2: GET /api/v1/wallet/balance ────────────────────────────────────

/**
 * Retorna el saldo actual de la wallet BOB del usuario.
 * Crea la wallet si es la primera vez que el usuario SRL la consulta.
 */
export async function getWalletBalance(req, res) {
  try {
    const user = req.user
    if (user.legalEntity !== 'SRL') {
      return res.status(403).json({ error: 'La wallet BOB es exclusiva para usuarios Bolivia (SRL).' })
    }

    const wallet = await getOrCreateWallet(user._id)

    return res.json({
      walletId:             wallet.walletId,
      currency:             'BOB',
      balance:              wallet.balance,
      balanceFrozen:        wallet.balanceFrozen,
      balanceReserved:      wallet.balanceReserved,
      balanceAvailable:     Math.max(0, wallet.balance - wallet.balanceReserved),
      status:               wallet.status,
      stellarPublicKey:     wallet.stellarPublicKey,
      trustlineEstablished: wallet.trustlineEstablished,
    })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'getWalletBalance' } })
    console.error('[Wallet] Error en getWalletBalance:', err.message)
    return res.status(500).json({ error: 'Error al obtener saldo de la wallet.' })
  }
}

// ─── FUNCIÓN 3: GET /api/v1/wallet/transactions ───────────────────────────────

/**
 * Historial paginado de movimientos del usuario.
 * Query params: page, limit, type, status
 */
export async function getWalletTransactions(req, res) {
  try {
    const user = req.user
    if (user.legalEntity !== 'SRL') {
      return res.status(403).json({ error: 'La wallet BOB es exclusiva para usuarios Bolivia (SRL).' })
    }

    const page  = Math.max(1, parseInt(req.query.page  ?? '1', 10))
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? '20', 10)))
    const skip  = (page - 1) * limit

    const filter = { userId: user._id }
    if (req.query.type)   filter.type   = req.query.type
    if (req.query.status) filter.status = req.query.status

    const [transactions, total] = await Promise.all([
      WalletTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('counterpartyUserId', 'firstName lastName email')
        .lean(),
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
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'getWalletTransactions' } })
    console.error('[Wallet] Error en getWalletTransactions:', err.message)
    return res.status(500).json({ error: 'Error al obtener historial de movimientos.' })
  }
}

// ─── FUNCIÓN 4: POST /api/v1/wallet/deposit/initiate ─────────────────────────

/**
 * Inicia un depósito BOB. Crea una WalletTransaction en 'awaiting_proof' (aún NO
 * es un depósito generado) y retorna las instrucciones de pago. El depósito pasa a
 * 'pending' recién cuando: (manual) el usuario adjunta el comprobante, o (bankQr)
 * el banco devuelve un QR válido. Solo entonces es acreditable / visible al admin.
 */
export async function initiateDeposit(req, res) {
  try {
    const user   = req.user
    const amount = Number(req.body.amount)

    if (user.legalEntity !== 'SRL') {
      return res.status(403).json({ error: 'La wallet BOB es exclusiva para usuarios Bolivia (SRL).' })
    }
    if (user.kycStatus !== 'approved') {
      return res.status(403).json({ error: 'Debes completar la verificación de identidad (KYC) antes de depositar.' })
    }
    if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: 'El campo amount es requerido.' })
    }
    if (amount < 50) {
      return res.status(400).json({ error: 'El monto mínimo de depósito es Bs. 50.' })
    }
    if (amount > 10000) {
      return res.status(400).json({ error: 'El monto máximo por depósito es Bs. 10.000.' })
    }

    const wallet = await getOrCreateWallet(user._id)
    if (wallet.status !== 'active') {
      return res.status(403).json({ error: 'Tu wallet no está activa. Contacta a soporte.' })
    }

    // ── Camino bankQr: QR bancario dinámico con confirmación automática ────────
    const bankQrCfg = getWalletDepositBankQrConfig()
    if (bankQrCfg.enabled) {
      const BANK_QR_DUE_DAYS = Math.max(0, Number(process.env.BANK_QR_DUE_DAYS ?? 1))
      const dueObj = new Date()
      dueObj.setDate(dueObj.getDate() + BANK_QR_DUE_DAYS)
      const yyyy = dueObj.getFullYear()
      const mm   = String(dueObj.getMonth() + 1).padStart(2, '0')
      const dd   = String(dueObj.getDate()).padStart(2, '0')
      const dueDate = `${yyyy}-${mm}-${dd}`
      const dueExpiresAt = new Date(dueObj)
      dueExpiresAt.setHours(23, 59, 59, 999)

      // Crear el registro en 'awaiting_proof' primero — su wtxId identifica el QR en
      // el banco. NO es un depósito "generado" todavía: pasa a 'pending' SOLO si el
      // banco devuelve un QR válido (respuesta correcta). Si la generación falla,
      // queda 'failed' y nunca se considera un depósito real.
      const wtx = await WalletTransaction.create({
        walletId:      wallet._id,
        userId:        user._id,
        type:          'deposit',
        amount,
        balanceBefore: wallet.balance,
        balanceAfter:  wallet.balance,  // se actualiza al confirmarse el pago
        status:        'awaiting_proof',
        currency:      'BOB',
        description:   'Depósito BOB vía QR bancario',
        reference:     null,
        expiresAt:     dueExpiresAt,
      })

      let qr
      try {
        const svc = getBankQrService(bankQrCfg.bankId)
        qr = await svc.generateQR({
          transactionId: wtx.wtxId,
          amount,
          currency:      'BOB',
          description:   `Alyto deposito ${wtx.wtxId}`.slice(0, 100),
          dueDate,
        })
      } catch (err) {
        await WalletTransaction.updateOne({ _id: wtx._id }, {
          status:      'failed',
          description: 'Error generando QR bancario',
        }).catch(() => {})
        Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'initiateDeposit:bankQr' } })
        console.error('[Wallet] Error generando QR bancario:', err.message)
        return res.status(502).json({ error: 'No se pudo generar el QR bancario. Intenta nuevamente en unos minutos.' })
      }

      // QR válido recibido → recién ahora el depósito existe como 'pending'
      // (a la espera de la confirmación automática del banco vía IPN).
      await WalletTransaction.updateOne({ _id: wtx._id }, {
        status:    'pending',
        reference: wtx.wtxId,
        bankQr:    { bankId: bankQrCfg.bankId, qrId: qr.qrId, dueDate },
      })

      return res.status(201).json({
        wtxId:        wtx.wtxId,
        method:       'bankQr',
        amount,
        currency:     'BOB',
        paymentQR:    qr.qrImage,
        bankQrId:     qr.qrId,
        reference:    wtx.wtxId,
        instructions: 'Escanea el QR con tu app bancaria. El saldo se acredita automáticamente al confirmarse el pago.',
        expiresAt:    dueExpiresAt,
      })
    }

    // ── Camino manual: transferencia bancaria + confirmación admin (legacy) ────
    // Se crea en 'awaiting_proof': el depósito NO está "generado" todavía. Solo
    // existe para entregarle al usuario la referencia que debe poner en la
    // transferencia. Pasa a 'pending' (y entra a la cola admin) recién cuando el
    // usuario adjunta el comprobante (uploadDepositProof). Por eso NO se notifica
    // al admin acá — no hay nada que confirmar aún.
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const wtx = await WalletTransaction.create({
      walletId:      wallet._id,
      userId:        user._id,
      type:          'deposit',
      amount,
      balanceBefore: wallet.balance,
      balanceAfter:  wallet.balance,  // se actualiza cuando admin confirme
      status:        'awaiting_proof',
      description:   'Depósito iniciado — pendiente de comprobante',
      expiresAt,
    })
    // Usar wtxId como referencia para identificar la transferencia
    await WalletTransaction.updateOne({ _id: wtx._id }, { reference: wtx.wtxId })

    return res.status(201).json({
      wtxId:         wtx.wtxId,
      method:        'manual',
      amount,
      currency:      'BOB',
      bankName:      process.env.SRL_BANK_NAME      ?? 'Banco Bisa',
      accountHolder: process.env.SRL_ACCOUNT_HOLDER ?? 'AV Finance SRL',
      accountNumber: process.env.SRL_ACCOUNT_NUMBER ?? '',
      accountType:   process.env.SRL_ACCOUNT_TYPE   ?? 'Cuenta Corriente',
      reference:     wtx.wtxId,
      instructions:  'Transfiere el monto exacto e incluye el número de referencia en el concepto.',
      expiresAt,
    })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'initiateDeposit' } })
    console.error('[Wallet] Error en initiateDeposit:', err.message)
    return res.status(500).json({ error: 'Error al iniciar el depósito.' })
  }
}

// ─── FUNCIÓN 5: POST /api/v1/wallet/send ──────────────────────────────────────

/**
 * Envío P2P entre usuarios SRL de Alyto.
 * Operación atómica con mongoose session.
 */
export async function sendP2P(req, res) {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const sender         = req.user
    const { recipientEmail, amount: rawAmount, description } = req.body
    const amount = Number(rawAmount)

    if (sender.legalEntity !== 'SRL') {
      await session.abortTransaction()
      return res.status(403).json({ error: 'La wallet BOB es exclusiva para usuarios Bolivia (SRL).' })
    }
    if (!recipientEmail || !amount) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'recipientEmail y amount son requeridos.' })
    }
    if (amount < 1) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'El monto mínimo de envío es Bs. 1.' })
    }
    if (recipientEmail.toLowerCase() === sender.email.toLowerCase()) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'No puedes enviarte dinero a ti mismo.' })
    }

    // ── Límite diario de envío (mismo cálculo que getDailyLimits) ──────────
    const SEND_LIMIT = parseFloat(process.env.WALLET_DAILY_SEND_LIMIT ?? '5000')
    if (SEND_LIMIT > 0) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
      const sentAgg = await WalletTransaction.aggregate([
        { $match: { userId: sender._id, type: 'send', status: 'completed', currency: 'BOB', createdAt: { $gte: todayStart } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]).session(session)
      const sentToday = sentAgg[0]?.total ?? 0
      if (sentToday + amount > SEND_LIMIT) {
        await session.abortTransaction()
        return res.status(400).json({
          error: `Superas tu límite diario de envío de Bs. ${SEND_LIMIT.toFixed(2)} (enviado hoy: Bs. ${sentToday.toFixed(2)}).`,
        })
      }
    }

    // Verificar destinatario
    const recipient = await User.findOne({ email: recipientEmail.toLowerCase() }).lean()
    if (!recipient) {
      await session.abortTransaction()
      return res.status(404).json({ error: 'Usuario destinatario no encontrado.' })
    }
    if (recipient.legalEntity !== 'SRL') {
      await session.abortTransaction()
      return res.status(400).json({ error: 'Solo puedes enviar a otros usuarios Bolivia (SRL).' })
    }

    // Nota: secuencial — MongoDB no permite operaciones concurrentes en la misma sesión
    const walletOrigen  = await getOrCreateWallet(sender._id, session)
    const walletDestino = await getOrCreateWallet(recipient._id, session)

    if (walletOrigen.status !== 'active') {
      await session.abortTransaction()
      return res.status(403).json({ error: 'Tu wallet no está activa.' })
    }
    if (walletDestino.status !== 'active') {
      await session.abortTransaction()
      return res.status(400).json({ error: 'La wallet del destinatario no está activa.' })
    }
    const balanceAvailable = Math.max(0, walletOrigen.balance - walletOrigen.balanceReserved)
    if (balanceAvailable < amount) {
      await session.abortTransaction()
      return res.status(400).json({ error: `Saldo insuficiente. Disponible: Bs. ${balanceAvailable.toFixed(2)}.` })
    }

    // Operación atómica
    const prevBalanceOrigen  = walletOrigen.balance
    const prevBalanceDestino = walletDestino.balance

    // Débito condicional: re-verifica saldo disponible EN el update (atómico) —
    // dos requests concurrentes no pueden pasar ambos el check de saldo.
    const debitResult = await WalletBOB.updateOne(
      {
        _id: walletOrigen._id,
        $expr: { $gte: [{ $subtract: ['$balance', { $ifNull: ['$balanceReserved', 0] }] }, amount] },
      },
      { $inc: { balance: -amount } },
      { session },
    )
    if (debitResult.modifiedCount !== 1) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'Saldo insuficiente.' })
    }
    await WalletBOB.updateOne({ _id: walletDestino._id }, { $inc: { balance:  amount } }, { session })

    const [wtxSend, wtxReceive] = await WalletTransaction.create([
      {
        walletId:           walletOrigen._id,
        userId:             sender._id,
        type:               'send',
        amount,
        balanceBefore:      prevBalanceOrigen,
        balanceAfter:       prevBalanceOrigen - amount,
        status:             'completed',
        description:        description ?? `Envío a ${recipient.firstName} ${recipient.lastName}`,
        counterpartyUserId: recipient._id,
        confirmedAt:        new Date(),
      },
      {
        walletId:           walletDestino._id,
        userId:             recipient._id,
        type:               'receive',
        amount,
        balanceBefore:      prevBalanceDestino,
        balanceAfter:       prevBalanceDestino + amount,
        status:             'completed',
        description:        `Recibido de ${sender.firstName} ${sender.lastName}`,
        counterpartyUserId: sender._id,
        confirmedAt:        new Date(),
      },
    ], { session, ordered: true })

    await session.commitTransaction()

    // Audit trail Stellar — fire and forget
    fireAuditTrail(wtxSend.wtxId, 'send', amount)

    // Push notification al destinatario
    notify(recipient._id, NOTIFICATIONS.p2pReceived(amount, `${sender.firstName} ${sender.lastName}`)).catch(() => {})

    // Notificar a admins — push + in-app
    const senderName   = `${sender.firstName} ${sender.lastName}`.trim();
    const receiverName = `${recipient.firstName} ${recipient.lastName}`.trim();
    notifyAdmins(NOTIFICATIONS.adminP2PTransfer(amount, senderName, receiverName)).catch(() => {});

    return res.json({
      wtxId:        wtxSend.wtxId,
      amount,
      recipientEmail,
      balanceAfter: prevBalanceOrigen - amount,
    })

  } catch (err) {
    await session.abortTransaction()
    // WriteConflict: dos operaciones concurrentes sobre la misma wallet — la
    // perdedora se aborta limpiamente (los fondos están protegidos). 409 + retry.
    if (err.code === 112 || err.errorLabels?.includes('TransientTransactionError')) {
      return res.status(409).json({ error: 'Operación concurrente detectada. Intenta de nuevo.' })
    }
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'sendP2P' } })
    console.error('[Wallet] Error en sendP2P:', err.message)
    return res.status(500).json({ error: 'Error al procesar el envío.' })
  } finally {
    session.endSession()
  }
}

// ─── FUNCIÓN 6: POST /api/v1/wallet/withdraw/request ─────────────────────────

/**
 * Solicitud de retiro BOB a cuenta bancaria boliviana.
 * Reserva el monto y crea un WalletTransaction pending para aprobación manual.
 */
export async function requestWithdrawal(req, res) {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const user = req.user
    const { amount: rawAmount, bankName, accountNumber, accountHolder, accountType } = req.body
    const amount = Number(rawAmount)

    if (user.legalEntity !== 'SRL') {
      await session.abortTransaction()
      return res.status(403).json({ error: 'La wallet BOB es exclusiva para usuarios Bolivia (SRL).' })
    }
    if (!amount || !bankName || !accountNumber || !accountHolder || !accountType) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'amount, bankName, accountNumber, accountHolder y accountType son requeridos.' })
    }
    if (amount < 100) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'El monto mínimo de retiro es Bs. 100.' })
    }

    const wallet = await getOrCreateWallet(user._id, session)
    if (wallet.status !== 'active') {
      await session.abortTransaction()
      return res.status(403).json({ error: 'Tu wallet no está activa.' })
    }
    const balanceAvailable = Math.max(0, wallet.balance - wallet.balanceReserved)
    if (balanceAvailable < amount) {
      await session.abortTransaction()
      return res.status(400).json({ error: `Saldo insuficiente. Disponible: Bs. ${balanceAvailable.toFixed(2)}.` })
    }

    // ── Límite diario de retiro (mismo cálculo que getDailyLimits) ──────────
    const WITHDRAW_LIMIT = parseFloat(process.env.WALLET_DAILY_WITHDRAW_LIMIT ?? '10000')
    if (WITHDRAW_LIMIT > 0) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
      const wAgg = await WalletTransaction.aggregate([
        { $match: { userId: user._id, type: 'withdrawal', status: { $in: ['pending', 'completed'] }, currency: 'BOB', createdAt: { $gte: todayStart } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]).session(session)
      const withdrawnToday = wAgg[0]?.total ?? 0
      if (withdrawnToday + amount > WITHDRAW_LIMIT) {
        await session.abortTransaction()
        return res.status(400).json({
          error: `Superas tu límite diario de retiro de Bs. ${WITHDRAW_LIMIT.toFixed(2)} (solicitado hoy: Bs. ${withdrawnToday.toFixed(2)}).`,
        })
      }
    }

    // ── Límites KYB (solo cuentas business con perfil aprobado) ──────────────
    if (user.accountType === 'business') {
      const bizProfile = await BusinessProfile.findOne({ userId: user._id, kybStatus: 'approved' }).lean()
      if (bizProfile?.transactionLimits) {
        const { maxSingleTransaction, currency: limitCurrency } = bizProfile.transactionLimits
        let limitInBOB = maxSingleTransaction
        if (limitCurrency !== 'BOB') {
          // Convertir límite a BOB usando tasa configurada
          const rateDoc = await ExchangeRate.findOne({ pair: { $in: ['BOB-USDC', 'BOB-USDT'] } }).lean()
          const bobRate = rateDoc?.rate ?? parseFloat(process.env.BOB_USD_RATE ?? '9.31')
          limitInBOB = maxSingleTransaction * (limitCurrency === 'USD' ? bobRate : 1)
        }
        if (amount > limitInBOB) {
          await session.abortTransaction()
          return res.status(400).json({
            error: `Monto excede el límite por transacción de tu cuenta. Máximo permitido: Bs. ${limitInBOB.toFixed(2)}.`,
          })
        }
      }
    }

    // Reservar monto — condicional: re-verifica disponible EN el update (atómico)
    const reserveResult = await WalletBOB.updateOne(
      {
        _id: wallet._id,
        $expr: { $gte: [{ $subtract: ['$balance', { $ifNull: ['$balanceReserved', 0] }] }, amount] },
      },
      { $inc: { balanceReserved: amount } },
      { session },
    )
    if (reserveResult.modifiedCount !== 1) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'Saldo insuficiente.' })
    }

    const [wtx] = await WalletTransaction.create([{
      walletId:      wallet._id,
      userId:        user._id,
      type:          'withdrawal',
      amount,
      balanceBefore: wallet.balance,
      balanceAfter:  wallet.balance,  // se actualiza cuando admin confirme
      status:        'pending',
      description:   `Retiro a ${bankName} — ${accountHolder}`,
      metadata:      { bankName, accountNumber, accountHolder, accountType },
      expiresAt:     new Date(Date.now() + 72 * 60 * 60 * 1000),  // 72h para retiros
    }], { session })
    await WalletTransaction.updateOne({ _id: wtx._id }, { reference: wtx.wtxId }, { session })

    // Imagen QR bancaria opcional (adjunta por el usuario para facilitar pago admin)
    const bankQrMeta = {}
    if (req.file) {
      bankQrMeta.bankQrImage = {
        data:       req.file.buffer.toString('base64'),
        mimetype:   req.file.mimetype,
        filename:   req.file.originalname,
        size:       req.file.size,
        uploadedAt: new Date(),
      }
    }

    await session.commitTransaction()

    // Guardar QR fuera de la sesión (no es monetario, fallo no es crítico)
    if (req.file) {
      await WalletTransaction.updateOne(
        { _id: wtx._id },
        { $set: { 'metadata.bankQrImage': bankQrMeta.bankQrImage } },
      ).catch(err => console.warn('[Wallet] Error guardando QR bancario:', err.message))
    }

    // Push notification al usuario
    notify(user._id, NOTIFICATIONS.withdrawalRequested(amount)).catch(() => {})

    // Notificar a admins — push + in-app
    const fullName = `${user.firstName} ${user.lastName}`.trim();
    notifyAdmins(NOTIFICATIONS.adminWithdrawalRequest(amount, fullName)).catch(() => {})

    return res.status(201).json({
      wtxId:   wtx.wtxId,
      amount,
      status:  'pending',
      message: 'Retiro en proceso. AV Finance SRL procesará la transferencia en 1-2 días hábiles.',
    })

  } catch (err) {
    await session.abortTransaction()
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'requestWithdrawal' } })
    console.error('[Wallet] Error en requestWithdrawal:', err.message)
    return res.status(500).json({ error: 'Error al solicitar el retiro.' })
  } finally {
    session.endSession()
  }
}

// ─── FUNCIÓN 7 (ADMIN): POST /api/v1/admin/wallet/deposit/confirm ─────────────

/**
 * Admin confirma que recibió la transferencia bancaria y acredita el saldo.
 * Operación atómica + audit trail Stellar.
 */
export async function adminConfirmDeposit(req, res) {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const admin                   = req.user
    const { wtxId, bankReference, note } = req.body

    if (!wtxId || !bankReference) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'wtxId y bankReference son requeridos.' })
    }

    const wtx = await WalletTransaction.findOne({ wtxId }).session(session)
    if (!wtx) {
      await session.abortTransaction()
      return res.status(404).json({ error: 'Transacción no encontrada.' })
    }
    if (wtx.type !== 'deposit') {
      await session.abortTransaction()
      return res.status(400).json({ error: 'La transacción no es un depósito.' })
    }
    // Los depósitos vía QR bancario se acreditan automáticamente (IPN del banco /
    // job de reconciliación). Bloquear la confirmación manual evita doble crédito.
    if (wtx.bankQr?.qrId) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'Este depósito es automático (QR bancario); no se confirma manualmente.' })
    }
    if (wtx.status === 'awaiting_proof') {
      await session.abortTransaction()
      return res.status(400).json({ error: 'El depósito aún no tiene comprobante adjunto.' })
    }
    if (wtx.status !== 'pending') {
      await session.abortTransaction()
      return res.status(400).json({ error: `El depósito ya fue procesado (status: ${wtx.status}).` })
    }

    const wallet = await WalletBOB.findById(wtx.walletId).session(session)
    if (!wallet) {
      await session.abortTransaction()
      return res.status(404).json({ error: 'Wallet no encontrada.' })
    }

    const prevBalance = wallet.balance
    const newBalance  = prevBalance + wtx.amount

    await WalletBOB.updateOne({ _id: wallet._id }, { $inc: { balance: wtx.amount } }, { session })
    await WalletTransaction.updateOne({ _id: wtx._id }, {
      status:        'completed',
      balanceBefore: prevBalance,
      balanceAfter:  newBalance,
      confirmedBy:   admin._id,
      confirmedAt:   new Date(),
      reference:     bankReference,
      metadata:      { ...(wtx.metadata ?? {}), bankReference, note: note ?? '' },
    }, { session })

    await session.commitTransaction()

    // Audit trail Stellar — fire and forget
    fireAuditTrail(wtxId, 'deposit', wtx.amount, bankReference)

    // Notificar al usuario
    const depositUser = await User.findById(wtx.userId).lean()
    if (depositUser?.email) {
      sendEmail(...EMAILS.walletDepositConfirmed(depositUser, {
        amount:     wtx.amount,
        currency:   'BOB',
        newBalance,
        wtxId,
      })).catch(err => console.error('[Wallet] Error email depósito confirmado:', err.message))
    }

    // Push + in-app notification — depósito confirmado
    notify(wtx.userId, NOTIFICATIONS.depositConfirmed(wtx.amount)).catch(() => {})

    return res.json({
      wtxId,
      balanceNew:  newBalance,
      confirmedAt: new Date(),
    })

  } catch (err) {
    await session.abortTransaction()
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'adminConfirmDeposit' } })
    console.error('[Wallet] Error en adminConfirmDeposit:', err.message)
    return res.status(500).json({ error: 'Error al confirmar el depósito.' })
  } finally {
    session.endSession()
  }
}

// ─── bankQr: confirmación automática de depósito BOB ──────────────────────────

/**
 * Acredita un depósito BOB pagado vía QR bancario (bankQr). Camino automático:
 * lo invocan el IPN del banco, el job de reconciliación y la simulación admin.
 *
 * Atómico (mongoose session) + idempotente: el claim condicional por status
 * 'pending' garantiza que IPN y job no acrediten dos veces el mismo pago.
 *
 * @param {object} wtx     — WalletTransaction (type='deposit', status='pending')
 * @param {object} payment — objeto PaymentQR del banco (o simulado)
 * @param {string} bankId  — 'bec' | ...
 * @param {string} source  — 'ipn' | 'reconciliation_job' | 'sweep' | 'admin_simulate'
 * @returns {Promise<{ ok: boolean, newBalance?: number, reason?: string }>}
 */
export async function confirmBankQrDeposit(wtx, payment, bankId, source) {
  const session = await mongoose.startSession()
  session.startTransaction()
  try {
    const wallet = await WalletBOB.findById(wtx.walletId).session(session)
    if (!wallet) {
      await session.abortTransaction()
      return { ok: false, reason: 'wallet_not_found' }
    }

    const parsed = payment?.paymentDate && payment?.paymentTime
      ? new Date(`${payment.paymentDate.split('T')[0]}T${payment.paymentTime}`)
      : new Date()
    const paidAt = isNaN(parsed) ? new Date() : parsed

    const prevBalance = wallet.balance
    const newBalance  = prevBalance + wtx.amount

    // Claim atómico — solo procede si la tx sigue pending (anti doble crédito)
    const claim = await WalletTransaction.updateOne(
      { _id: wtx._id, type: 'deposit', status: 'pending' },
      {
        $set: {
          status:           'completed',
          balanceBefore:    prevBalance,
          balanceAfter:     newBalance,
          confirmedAt:      new Date(),
          reference:        payment?.qrId ?? wtx.bankQr?.qrId,
          'bankQr.paidAt':  paidAt,
          'bankQr.payment': payment,
          metadata:         { ...(wtx.metadata ?? {}), bankQrSource: source },
        },
      },
      { session },
    )
    if (claim.modifiedCount === 0) {
      await session.abortTransaction()
      return { ok: false, reason: 'already_processed' }
    }

    await WalletBOB.updateOne({ _id: wallet._id }, { $inc: { balance: wtx.amount } }, { session })
    await session.commitTransaction()

    // Audit trail Stellar — fire and forget
    fireAuditTrail(wtx.wtxId, 'deposit', wtx.amount, payment?.qrId ?? wtx.bankQr?.qrId)

    // Notificar al usuario (email + push/in-app) — fire and forget
    User.findById(wtx.userId).lean().then((u) => {
      if (u?.email) {
        sendEmail(...EMAILS.walletDepositConfirmed(u, {
          amount:     wtx.amount,
          currency:   'BOB',
          newBalance,
          wtxId:      wtx.wtxId,
        })).catch(() => {})
      }
    }).catch(() => {})
    notify(wtx.userId, NOTIFICATIONS.depositConfirmed(wtx.amount)).catch(() => {})

    console.log(`[Wallet] ✅ Depósito bankQr acreditado (${source})`, { wtxId: wtx.wtxId, bankId, amount: wtx.amount })
    return { ok: true, newBalance }

  } catch (err) {
    await session.abortTransaction().catch(() => {})
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'confirmBankQrDeposit' } })
    console.error('[Wallet] Error en confirmBankQrDeposit:', err.message)
    throw err
  } finally {
    session.endSession()
  }
}

/**
 * Marca un depósito bankQr vencido sin pago como failed.
 * No hubo acreditación, así que no hay saldo que revertir.
 *
 * @param {object} wtx    — WalletTransaction pending
 * @param {string} bankId
 * @param {string} reason
 * @returns {Promise<boolean>} true si se marcó (false si otra corrida la tomó)
 */
export async function failExpiredBankQrDeposit(wtx, bankId, reason) {
  const upd = await WalletTransaction.updateOne(
    { _id: wtx._id, type: 'deposit', status: 'pending' },
    {
      $set: {
        status:      'failed',
        description: `Depósito QR vencido: ${reason}`,
        metadata:    { ...(wtx.metadata ?? {}), bankQrExpired: true, expireReason: reason, expiredAt: new Date() },
      },
    },
  )
  if (upd.modifiedCount > 0) {
    console.log('[Wallet] ⏲️ Depósito bankQr vencido archivado', { wtxId: wtx.wtxId, bankId, reason })
  }
  return upd.modifiedCount > 0
}

// ─── FUNCIÓN 8 (ADMIN): GET /api/v1/admin/wallet ─────────────────────────────

/**
 * Lista paginada de todas las WalletBOB con usuario populado.
 */
export async function adminListWallets(req, res) {
  try {
    const page  = Math.max(1, parseInt(req.query.page  ?? '1', 10))
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '20', 10)))
    const skip  = (page - 1) * limit

    const filter = {}
    if (req.query.status) filter.status = req.query.status

    const [wallets, total] = await Promise.all([
      WalletBOB.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'firstName lastName email kycStatus legalEntity')
        .lean(),
      WalletBOB.countDocuments(filter),
    ])

    // Añadir conteo de transacciones pendientes por wallet
    const walletsWithPending = await Promise.all(
      wallets.map(async w => {
        const pendingCount = await WalletTransaction.countDocuments({
          walletId: w._id,
          status:   'pending',
        })
        return { ...w, pendingTransactions: pendingCount }
      }),
    )

    return res.json({
      wallets: walletsWithPending,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'adminListWallets' } })
    console.error('[Wallet] Error en adminListWallets:', err.message)
    return res.status(500).json({ error: 'Error al listar wallets.' })
  }
}

// ─── FUNCIÓN 9 (ADMIN): GET /api/v1/admin/wallet/deposits/pending ─────────────

/**
 * Lista depósitos pendientes de confirmación.
 */
export async function adminListPendingDeposits(req, res) {
  try {
    // Cola de confirmación MANUAL: solo depósitos 'pending' (con comprobante adjunto)
    // y SIN bankQr (los QR bancarios se confirman solos vía IPN — no van a esta cola).
    // Los 'awaiting_proof' (iniciados sin comprobante) quedan excluidos por el status.
    const pending = await WalletTransaction.find({
      type:   'deposit',
      status: 'pending',
      $or: [{ bankQr: { $exists: false } }, { 'bankQr.qrId': { $exists: false } }],
    })
      .sort({ createdAt: -1 })
      .populate('userId', 'firstName lastName email kycStatus phone identityDocument.type')
      .lean()

    // Shape explícito y liviano: toda la info que el admin necesita SIN el blob
    // base64 del comprobante (se obtiene aparte vía /deposits/:wtxId/comprobante).
    const deposits = pending.map((d) => {
      const u     = d.userId ?? {}
      const proof = d.metadata?.paymentProof ?? null
      return {
        wtxId:       d.wtxId,
        amount:      d.amount,
        currency:    d.currency ?? 'BOB',
        reference:   d.reference,
        method:      'manual',
        status:      d.status,
        description: d.description,
        createdAt:   d.createdAt,
        expiresAt:   d.expiresAt,
        user: {
          id:           u._id,
          name:         `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || '—',
          email:        u.email ?? null,
          phone:        u.phone ?? null,
          documentType: u.identityDocument?.type ?? null,
          kycStatus:    u.kycStatus ?? null,
        },
        comprobante: proof
          ? { present: true, filename: proof.filename, mimetype: proof.mimetype,
              size: proof.size, uploadedAt: proof.uploadedAt }
          : { present: false },
      }
    })

    return res.json({ deposits, total: deposits.length })

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'adminListPendingDeposits' } })
    console.error('[Wallet] Error en adminListPendingDeposits:', err.message)
    return res.status(500).json({ error: 'Error al listar depósitos pendientes.' })
  }
}

// ─── ADMIN: GET /api/v1/admin/wallet/deposits/:wtxId/comprobante ───────────────

/**
 * Devuelve la imagen del comprobante (base64) de un depósito BOB manual, para que
 * el admin la revise antes de confirmar. Espeja getTransactionComprobante pero
 * sobre WalletTransaction.
 */
export async function adminGetDepositComprobante(req, res) {
  const { wtxId } = req.params

  let wtx
  try {
    wtx = await WalletTransaction.findOne({ wtxId, type: 'deposit' })
      .select('wtxId metadata userId amount currency status')
      .lean()
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'adminGetDepositComprobante' } })
    return res.status(500).json({ error: 'Error interno del servidor.' })
  }

  if (!wtx) {
    return res.status(404).json({ error: 'Depósito no encontrado.' })
  }

  const proof = wtx.metadata?.paymentProof
  if (!proof?.data) {
    return res.status(404).json({ error: 'Este depósito no tiene comprobante subido.' })
  }

  return res.status(200).json({
    base64:     proof.data,
    mimeType:   proof.mimetype,
    filename:   proof.filename,
    size:       proof.size,
    uploadedAt: proof.uploadedAt,
  })
}

// ─── FUNCIÓN 10 (ADMIN): PATCH /api/v1/admin/wallet/:userId/freeze ────────────

/**
 * Congela la wallet de un usuario.
 * Mueve balance → balanceFrozen.
 * Fase 26: registra evento de congelamiento en Stellar (fire-and-forget).
 */
export async function adminFreezeWallet(req, res) {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { userId }                     = req.params
    const { reason, reportNumber }       = req.body
    const admin                          = req.user

    if (!reason) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'El campo reason es obligatorio para congelar una wallet.' })
    }

    const wallet = await WalletBOB.findOne({ userId }).session(session)
    if (!wallet) {
      await session.abortTransaction()
      return res.status(404).json({ error: 'Wallet no encontrada para este usuario.' })
    }
    if (wallet.status === 'frozen') {
      await session.abortTransaction()
      return res.status(400).json({ error: 'La wallet ya está congelada.' })
    }

    const now = new Date()
    await WalletBOB.updateOne({ _id: wallet._id }, {
      status:        'frozen',
      balanceFrozen: wallet.balance,
      balance:       0,
      frozenReason:  reason,
      frozenAt:      now,
      frozenBy:      admin._id,
    }, { session })

    await WalletTransaction.create([{
      walletId:      wallet._id,
      userId,
      type:          'freeze',
      amount:        wallet.balance,
      balanceBefore: wallet.balance,
      balanceAfter:  0,
      status:        'completed',
      description:   `Wallet congelada por compliance. Razón: ${reason}`,
      confirmedBy:   admin._id,
      confirmedAt:   now,
      metadata:      { reason, reportNumber: reportNumber ?? null },
    }], { session })

    await session.commitTransaction()

    // Fase 26: registrar congelamiento en Stellar como evidencia ASFI (fire-and-forget)
    if (wallet.stellarPublicKey) {
      freezeUserTrustline(wallet.stellarPublicKey, 'USDC').catch(() => {})
    }

    // Notificar al usuario
    const frozenUser = await User.findById(userId).lean()
    if (frozenUser && process.env.SENDGRID_TEMPLATE_FAILED) {
      sendEmail(
        frozenUser.email,
        process.env.SENDGRID_TEMPLATE_FAILED,
        {
          firstName: frozenUser.firstName,
          subject:   'Tu wallet ha sido suspendida temporalmente',
          message:   'Por cumplimiento regulatorio, tu wallet ha sido suspendida. Contacta a soporte para más información.',
        },
      ).catch(() => {})
    }

    // Push notification — wallet congelada
    notify(userId, NOTIFICATIONS.walletFrozen()).catch(() => {})

    return res.json({
      walletId:  wallet.walletId,
      status:    'frozen',
      frozenAt:  now,
      reason,
    })

  } catch (err) {
    await session.abortTransaction()
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'adminFreezeWallet' } })
    console.error('[Wallet] Error en adminFreezeWallet:', err.message)
    return res.status(500).json({ error: 'Error al congelar la wallet.' })
  } finally {
    session.endSession()
  }
}

// ─── FUNCIÓN 11 (ADMIN): PATCH /api/v1/admin/wallet/:userId/unfreeze ──────────

/**
 * Descongela la wallet de un usuario.
 * Mueve balanceFrozen → balance.
 */
export async function adminUnfreezeWallet(req, res) {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { userId } = req.params
    const admin      = req.user

    const wallet = await WalletBOB.findOne({ userId }).session(session)
    if (!wallet) {
      await session.abortTransaction()
      return res.status(404).json({ error: 'Wallet no encontrada para este usuario.' })
    }
    if (wallet.status !== 'frozen') {
      await session.abortTransaction()
      return res.status(400).json({ error: 'La wallet no está congelada.' })
    }

    const now = new Date()
    await WalletBOB.updateOne({ _id: wallet._id }, {
      status:        'active',
      balance:       wallet.balanceFrozen,
      balanceFrozen: 0,
      frozenReason:  null,
      frozenAt:      null,
      frozenBy:      null,
    }, { session })

    await WalletTransaction.create([{
      walletId:      wallet._id,
      userId,
      type:          'unfreeze',
      amount:        wallet.balanceFrozen,
      balanceBefore: 0,
      balanceAfter:  wallet.balanceFrozen,
      status:        'completed',
      description:   'Wallet descongelada por admin',
      confirmedBy:   admin._id,
      confirmedAt:   now,
    }], { session })

    await session.commitTransaction()

    // Fase 26: registrar descongelamiento en Stellar como evidencia ASFI (fire-and-forget)
    if (wallet.stellarPublicKey) {
      unfreezeUserTrustline(wallet.stellarPublicKey, 'USDC').catch(() => {})
    }

    // Notificar al usuario
    const unfrozenUser = await User.findById(userId).lean()
    if (unfrozenUser && process.env.SENDGRID_TEMPLATE_COMPLETED) {
      sendEmail(
        unfrozenUser.email,
        process.env.SENDGRID_TEMPLATE_COMPLETED,
        {
          firstName: unfrozenUser.firstName,
          subject:   'Tu wallet ha sido reactivada',
          message:   'Tu wallet BOB ha sido reactivada. Ya puedes operar normalmente.',
        },
      ).catch(() => {})
    }

    // Push notification — wallet reactivada
    notify(userId, NOTIFICATIONS.walletUnfrozen(wallet.balanceFrozen)).catch(() => {})

    return res.json({
      walletId: wallet.walletId,
      status:   'active',
      balance:  wallet.balanceFrozen,
    })

  } catch (err) {
    await session.abortTransaction()
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'adminUnfreezeWallet' } })
    console.error('[Wallet] Error en adminUnfreezeWallet:', err.message)
    return res.status(500).json({ error: 'Error al descongelar la wallet.' })
  } finally {
    session.endSession()
  }
}

// ─── FUNCIÓN 12: GET /api/v1/wallet/deposit/qr-images ────────────────────────

/**
 * Retorna los QRs activos de depósito Wallet BOB configurados por el admin.
 * Solo accesible por usuarios SRL con KYC aprobado.
 */
export async function getDepositQRImages(req, res) {
  try {
    const SRLConfig = (await import('../models/SRLConfig.js')).default
    const doc = await SRLConfig.findOne({ key: 'srl_bolivia' })
      .select('walletQrImages')
      .lean()

    const qrImages = (doc?.walletQrImages ?? [])
      .filter(q => q.isActive)
      .map(q => ({ qrId: q.qrId, label: q.label, imageBase64: q.imageBase64 }))

    return res.status(200).json({ qrImages })
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'getDepositQRImages' } })
    return res.status(500).json({ error: 'Error al obtener los QRs de depósito.' })
  }
}

// ─── FUNCIÓN 13: POST /api/v1/wallet/deposit/:wtxId/comprobante ───────────────

/**
 * El usuario sube el comprobante de su depósito BOB pendiente.
 * Se almacena en metadata.paymentProof y se notifica a admins.
 *
 * Auth: Bearer JWT
 * Content-Type: multipart/form-data (campo: 'comprobante')
 */
export async function uploadDepositProof(req, res) {
  const { wtxId } = req.params
  const userId    = req.user._id

  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo.' })
  }

  let wtx
  try {
    wtx = await WalletTransaction.findOne({ wtxId, userId, type: 'deposit' })
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'uploadDepositProof' } })
    return res.status(500).json({ error: 'Error interno del servidor.' })
  }

  if (!wtx) {
    return res.status(404).json({ error: 'Depósito no encontrado.' })
  }

  // Los depósitos vía QR bancario (bankQr) se confirman solos vía IPN — no se les
  // adjunta comprobante manual.
  if (wtx.bankQr?.qrId) {
    return res.status(400).json({ error: 'Este depósito se confirma automáticamente; no requiere comprobante.' })
  }

  // Solo un depósito manual a la espera de comprobante puede recibirlo. Si ya está
  // 'pending' (comprobante subido), 'completed', etc. → ya fue procesado.
  if (wtx.status !== 'awaiting_proof') {
    return res.status(400).json({ error: 'Este depósito ya fue procesado.' })
  }

  if (wtx.metadata?.paymentProof) {
    return res.status(409).json({ error: 'Ya se subió un comprobante para este depósito.' })
  }

  const file = req.file
  wtx.metadata = {
    ...wtx.metadata,
    paymentProof: {
      data:       file.buffer.toString('base64'),
      mimetype:   file.mimetype,
      filename:   file.originalname,
      size:       file.size,
      uploadedAt: new Date(),
    },
  }
  // Comprobante adjunto → el depósito "se genera" y entra a la cola del admin.
  wtx.status = 'pending'

  try {
    await wtx.save()
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'uploadDepositProof' } })
    console.error('[WalletDeposit] Error guardando comprobante:', err.message)
    return res.status(500).json({ error: 'Error guardando el comprobante.' })
  }

  const user = await User.findById(userId).select('firstName lastName').lean()
  const userName = user ? `${user.firstName} ${user.lastName}`.trim() : 'Usuario'
  notifyAdmins(NOTIFICATIONS.adminPaymentProof(wtx.wtxId, userName)).catch(() => {})

  return res.status(200).json({
    ok:      true,
    message: 'Comprobante recibido. Verificaremos tu depósito en 2–4 horas hábiles.',
  })
}

// ─── FUNCIÓN 12 (ADMIN): GET /api/v1/admin/wallet/withdrawals/pending ────────

export async function adminListPendingWithdrawals(req, res) {
  try {
    const pending = await WalletTransaction.find({ type: 'withdrawal', status: 'pending' })
      .sort({ createdAt: -1 })
      .populate('userId', 'firstName lastName email kycStatus legalEntity')
      .lean()

    return res.json({ withdrawals: pending, total: pending.length })
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'adminListPendingWithdrawals' } })
    console.error('[Wallet] Error en adminListPendingWithdrawals:', err.message)
    return res.status(500).json({ error: 'Error al listar retiros pendientes.' })
  }
}

// ─── FUNCIÓN 13 (ADMIN): POST /api/v1/admin/wallet/withdrawal/confirm ────────

export async function adminConfirmWithdrawal(req, res) {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const admin                         = req.user
    const { wtxId, bankReference, note } = req.body

    if (!wtxId || !bankReference) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'wtxId y bankReference son requeridos.' })
    }

    const wtx = await WalletTransaction.findOne({ wtxId }).session(session)
    if (!wtx || wtx.type !== 'withdrawal' || wtx.status !== 'pending') {
      await session.abortTransaction()
      return res.status(404).json({ error: 'Retiro pendiente no encontrado.' })
    }

    const wallet = await WalletBOB.findById(wtx.walletId).session(session)
    if (!wallet) {
      await session.abortTransaction()
      return res.status(404).json({ error: 'Wallet no encontrada.' })
    }

    const prevBalance = wallet.balance
    const newBalance  = prevBalance - wtx.amount

    // Descontar del saldo real y liberar reserva
    await WalletBOB.updateOne(
      { _id: wallet._id },
      { $inc: { balance: -wtx.amount, balanceReserved: -wtx.amount } },
      { session },
    )
    await WalletTransaction.updateOne({ _id: wtx._id }, {
      status:        'completed',
      balanceBefore: prevBalance,
      balanceAfter:  newBalance,
      confirmedBy:   admin._id,
      confirmedAt:   new Date(),
      reference:     bankReference,
      metadata:      { ...(wtx.metadata ?? {}), bankReference, note: note ?? '' },
    }, { session })

    await session.commitTransaction()

    notify(wtx.userId, NOTIFICATIONS.withdrawalCompleted?.(wtx.amount) ?? {
      title:   'Retiro procesado',
      body:    `Tu retiro de Bs. ${wtx.amount.toFixed(2)} fue transferido a tu cuenta bancaria.`,
      type:    'wallet',
    }).catch(() => {})

    return res.json({ wtxId, newBalance, confirmedAt: new Date() })

  } catch (err) {
    await session.abortTransaction()
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'adminConfirmWithdrawal' } })
    console.error('[Wallet] Error en adminConfirmWithdrawal:', err.message)
    return res.status(500).json({ error: 'Error al confirmar el retiro.' })
  } finally {
    session.endSession()
  }
}

// ─── FUNCIÓN 14 (ADMIN): POST /api/v1/admin/wallet/withdrawal/reject ─────────

export async function adminRejectWithdrawal(req, res) {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { wtxId, reason } = req.body

    if (!wtxId) {
      await session.abortTransaction()
      return res.status(400).json({ error: 'wtxId es requerido.' })
    }

    const wtx = await WalletTransaction.findOne({ wtxId }).session(session)
    if (!wtx || wtx.type !== 'withdrawal' || wtx.status !== 'pending') {
      await session.abortTransaction()
      return res.status(404).json({ error: 'Retiro pendiente no encontrado.' })
    }

    // Liberar la reserva sin descontar el saldo
    await WalletBOB.updateOne(
      { _id: wtx.walletId },
      { $inc: { balanceReserved: -wtx.amount } },
      { session },
    )
    await WalletTransaction.updateOne({ _id: wtx._id }, {
      status:   'failed',
      metadata: { ...(wtx.metadata ?? {}), rejectReason: reason ?? '' },
    }, { session })

    await session.commitTransaction()

    notify(wtx.userId, {
      title: 'Retiro rechazado',
      body:  `Tu retiro de Bs. ${wtx.amount.toFixed(2)} no pudo procesarse. ${reason ? `Motivo: ${reason}` : 'Contáctanos para más información.'}`,
      type:  'wallet',
    }).catch(() => {})

    return res.json({ wtxId, status: 'failed' })

  } catch (err) {
    await session.abortTransaction()
    Sentry.captureException(err, { tags: { controller: 'walletController', fn: 'adminRejectWithdrawal' } })
    console.error('[Wallet] Error en adminRejectWithdrawal:', err.message)
    return res.status(500).json({ error: 'Error al rechazar el retiro.' })
  } finally {
    session.endSession()
  }
}

// ─── FUNCIÓN 15: GET /api/v1/wallet/balance-history ──────────────────────────

/**
 * GET /api/v1/wallet/balance-history?days=7&currency=BOB|USDC
 * Saldo de cierre diario para los últimos N días — usado en el sparkline del card.
 */
export async function getBalanceHistory(req, res) {
  try {
    const user     = req.user
    const days     = Math.min(30, Math.max(7, parseInt(req.query.days ?? '7', 10)))
    const currency = req.query.currency === 'USDC' ? 'USDC' : 'BOB'

    const since = new Date()
    since.setDate(since.getDate() - (days - 1))
    since.setHours(0, 0, 0, 0)

    const [txs, txBefore] = await Promise.all([
      WalletTransaction.find({ userId: user._id, currency, status: 'completed', createdAt: { $gte: since } })
        .sort({ createdAt: 1 }).select('balanceAfter createdAt').lean(),
      WalletTransaction.findOne({ userId: user._id, currency, status: 'completed', createdAt: { $lt: since } })
        .sort({ createdAt: -1 }).select('balanceAfter').lean(),
    ])

    const buckets = {}
    for (let i = 0; i < days; i++) {
      const d = new Date(since)
      d.setDate(d.getDate() + i)
      buckets[d.toISOString().slice(0, 10)] = null
    }
    for (const tx of txs) {
      const key = new Date(tx.createdAt).toISOString().slice(0, 10)
      if (key in buckets) buckets[key] = tx.balanceAfter
    }

    let carry = txBefore?.balanceAfter ?? 0
    const history = Object.entries(buckets).map(([date, balance]) => {
      if (balance !== null) carry = balance
      return { date, balance: balance !== null ? balance : carry }
    })

    return res.json({ history, currency })
  } catch (err) {
    console.error('[Wallet] Error en getBalanceHistory:', err.message)
    return res.status(500).json({ error: 'Error al obtener el historial de saldo.' })
  }
}

// ─── FUNCIÓN 16: GET /api/v1/wallet/daily-limits ─────────────────────────────

/**
 * GET /api/v1/wallet/daily-limits
 * Uso diario de envíos y retiros BOB frente a los límites configurados.
 */
export async function getDailyLimits(req, res) {
  try {
    const user = req.user
    const SEND_LIMIT     = parseFloat(process.env.WALLET_DAILY_SEND_LIMIT     ?? '5000')
    const WITHDRAW_LIMIT = parseFloat(process.env.WALLET_DAILY_WITHDRAW_LIMIT ?? '10000')

    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const [sendAgg, withdrawAgg] = await Promise.all([
      WalletTransaction.aggregate([
        { $match: { userId: user._id, type: 'send', status: 'completed', currency: 'BOB', createdAt: { $gte: todayStart } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      WalletTransaction.aggregate([
        { $match: { userId: user._id, type: 'withdrawal', status: { $in: ['pending', 'completed'] }, currency: 'BOB', createdAt: { $gte: todayStart } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ])

    return res.json({
      send:       { used: sendAgg[0]?.total ?? 0,     limit: SEND_LIMIT },
      withdrawal: { used: withdrawAgg[0]?.total ?? 0, limit: WITHDRAW_LIMIT },
    })
  } catch (err) {
    console.error('[Wallet] Error en getDailyLimits:', err.message)
    return res.status(500).json({ error: 'Error al obtener los límites diarios.' })
  }
}

// ─── FUNCIÓN 17: GET /api/v1/wallet/export ────────────────────────────────────

/**
 * GET /api/v1/wallet/export?currency=BOB|USDC&month=YYYY-MM
 * Descarga el historial de transacciones como CSV (BOM UTF-8 para Excel/Sheets).
 */
export async function exportTransactions(req, res) {
  try {
    const user     = req.user
    const currency = req.query.currency === 'USDC' ? 'USDC' : 'BOB'
    const month    = req.query.month

    let dateFilter = {}
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number)
      dateFilter = { createdAt: { $gte: new Date(y, m - 1, 1), $lt: new Date(y, m, 1) } }
    }

    const txs = await WalletTransaction.find({ userId: user._id, currency, ...dateFilter })
      .sort({ createdAt: -1 }).limit(1000).lean()

    const typeLabels = {
      deposit:      'Depósito',
      withdrawal:   'Retiro',
      send:         'Envío P2P',
      receive:      'Recibo P2P',
      fee:          'Comisión',
      freeze:       'Congelamiento',
      unfreeze:     'Descongelamiento',
      bob_to_usdc:  'Conversión BOB→USDC',
      usdc_deposit: 'Depósito USDC',
    }
    const statusLabels = { pending: 'Pendiente', completed: 'Completado', failed: 'Fallido', reversed: 'Revertido' }

    const rows = [
      ['Fecha', 'Tipo', 'Moneda', 'Monto', 'Saldo Previo', 'Saldo Post', 'Estado', 'Descripción', 'Referencia'],
      ...txs.map(tx => [
        new Date(tx.createdAt).toLocaleString('es-BO', { timeZone: 'America/La_Paz' }),
        typeLabels[tx.type] ?? tx.type,
        currency,
        tx.amount.toFixed(2),
        tx.balanceBefore.toFixed(2),
        tx.balanceAfter.toFixed(2),
        statusLabels[tx.status] ?? tx.status,
        (tx.description ?? '').replace(/[",\n]/g, ' '),
        tx.reference ?? '',
      ]),
    ]

    const csv = rows.map(r => r.map(v => `"${String(v)}"`).join(',')).join('\r\n')
    const filename = `alyto_${currency.toLowerCase()}_${month ?? 'historial'}.csv`

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return res.send('﻿' + csv)
  } catch (err) {
    console.error('[Wallet] Error en exportTransactions:', err.message)
    return res.status(500).json({ error: 'Error al exportar.' })
  }
}
