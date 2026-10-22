/**
 * qrWalletController.js — QR Alyto Wallet (Fase 29)
 *
 * Exclusivo para usuarios legalEntity === 'SRL' con KYC aprobado.
 *
 * Endpoints:
 *   POST /api/v1/wallet/qr/generate  — genera QR de cobro, P2P o depósito
 *   POST /api/v1/wallet/qr/scan      — procesa el pago al escanear un QR
 *   GET  /api/v1/wallet/qr/preview   — previsualiza un QR sin cobrar
 */

import mongoose          from 'mongoose';
import User              from '../models/User.js';
import WalletBOB         from '../models/WalletBOB.js';
import WalletTransaction from '../models/WalletTransaction.js';
import { generateQR, verifyQR }        from '../services/qrWalletService.js';
import { notify, NOTIFICATIONS }       from '../services/notifications.js';
import { getOrCreateWallet, fireAuditTrail } from './walletController.js';
import { executeUsdcP2pTransfer, fireUSDCAuditTrail } from './walletUSDCController.js';
import WalletUSDC        from '../models/WalletUSDC.js';
import Sentry            from '../services/sentry.js';
import { AbortoDeliberado, abortarHttp } from '../utils/transactionAbort.js';

// ── POST /api/v1/wallet/qr/generate ──────────────────────────────────────────

/**
 * Genera un QR Alyto firmado.
 * Body: { type, amount?, description?, expiresInSecs? }
 */
export async function generateWalletQR(req, res) {
  try {
    const { type, amount, description, expiresInSecs } = req.body;
    const asset = req.body.asset ?? 'BOB';
    const user = req.user;

    if (user.legalEntity !== 'SRL') {
      return res.status(403).json({ error: 'QR Wallet exclusivo para usuarios Bolivia (SRL).' });
    }
    if (user.kycStatus !== 'approved') {
      return res.status(403).json({ error: 'KYC requerido para usar QR Wallet.' });
    }

    // Para charge/p2p verificar que la wallet del asset correcto existe y está activa
    if (type === 'charge' || type === 'p2p') {
      const Model  = asset === 'USDC' ? WalletUSDC : WalletBOB;
      const wallet = await Model.findOne({ userId: user._id }).lean();
      if (!wallet || wallet.status !== 'active') {
        return res.status(403).json({ error: `Tu wallet ${asset} no está activa.` });
      }
    }

    const result = await generateQR({
      type,
      asset,
      creatorUserId: user._id.toString(),
      creatorName:   `${user.firstName} ${user.lastName}`.trim(),
      amount:        amount != null ? Number(amount) : undefined,
      description,
      expiresInSecs: expiresInSecs != null ? Number(expiresInSecs) : undefined,
    });

    return res.status(201).json({
      qrId:      result.qrId,
      qrBase64:  result.qrBase64,
      type,
      asset,
      amount:    amount != null ? Number(amount) : null,
      expiresAt: result.expiresAt,
    });

  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'qrWalletController', fn: 'generateWalletQR' } });
    return res.status(400).json({ error: err.message });
  }
}

// ── POST /api/v1/wallet/qr/scan ───────────────────────────────────────────────

/**
 * Procesa el pago al escanear un QR Alyto.
 * Body: { qrContent, amount? }  — amount solo requerido para QR type 'deposit'
 *
 * Operación atómica con mongoose session.
 */
export async function scanAndPayQR(req, res) {
  const payer = req.user;
  const { qrContent, amount: overrideAmount } = req.body;

  // Todo lo de acá arriba es validación pura: ni lee ni escribe en la base, así
  // que no necesita una transacción abierta para rechazar.
  if (payer.legalEntity !== 'SRL') {
    return res.status(403).json({ error: 'QR Wallet exclusivo para usuarios Bolivia (SRL).' });
  }
  if (payer.kycStatus !== 'approved') {
    return res.status(403).json({ error: 'KYC requerido.' });
  }
  if (!qrContent) {
    return res.status(400).json({ error: 'qrContent es requerido.' });
  }

  // 1. Verificar QR (firma + expiración)
  const { valid, payload, error: qrError } = verifyQR(qrContent);
  if (!valid) return res.status(400).json({ error: qrError });

  // 2. No permitir autopago
  if (payload.creatorUserId === payer._id.toString()) {
    return res.status(400).json({ error: 'No puedes pagarte a ti mismo.' });
  }

  const asset = payload.asset ?? 'BOB';
  const session = await mongoose.startSession();
  let post;

  try {
    // `withTransaction` reintenta los conflictos de escritura. Para abortar hay
    // que LANZAR: un `return` haría commit de lo ya escrito.
    await session.withTransaction(async () => {
      // 2-bis. Rama USDC — delega en la transferencia ledger-only compartida (P1)
      if (asset === 'USDC') {
        const finalAmount = payload.type === 'deposit' ? Number(overrideAmount) : Number(payload.amount);
        if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
          abortarHttp(400, { error: 'Monto inválido.' });
        }
        // Límites (mín/máx por-tx, diario) se enforce en executeUsdcP2pTransfer.
        const recipient = await User.findById(payload.creatorUserId)
          .select('_id firstName lastName alytoAlias legalEntity accountType').lean();
        if (!recipient || recipient.legalEntity !== 'SRL') {
          abortarHttp(404, { error: 'Destinatario no encontrado.' });
        }

        // Los errores de límite y saldo vienen con `httpStatus` propio y sin
        // etiqueta de transitorio, así que no se reintentan: suben al catch.
        const result = await executeUsdcP2pTransfer(session, {
          sender:      payer,
          recipient,
          amount:      finalAmount,
          description: payload.description ? `QR: ${payload.description}` : 'Pago QR USDC',
          source:      'qr',
          // Anti-replay: charge/p2p son de un solo uso (deposit es reutilizable)
          ...(payload.type !== 'deposit' && payload.qrId ? { qrId: payload.qrId } : {}),
        });

        post = { asset: 'USDC', result, recipient, finalAmount };
        return;
      }

      // 3. Determinar monto final
      // deposit → el pagador elige el monto (overrideAmount)
      // charge/p2p → el monto está fijo en el QR
      const finalAmount = payload.type === 'deposit'
        ? Number(overrideAmount)
        : Number(payload.amount);

      if (!finalAmount || finalAmount < 1) {
        abortarHttp(400, { error: 'Monto inválido. Mínimo Bs. 1.' });
      }

      // 4. Buscar receptor
      const recipient = await User.findById(payload.creatorUserId).lean();
      if (!recipient || recipient.legalEntity !== 'SRL') {
        abortarHttp(404, { error: 'Destinatario no encontrado.' });
      }

      // 5. Obtener wallets (crear si no existen)
      // Nota: secuencial — MongoDB no permite operaciones concurrentes en la misma sesión
      const walletPayer     = await getOrCreateWallet(payer._id, session);
      const walletRecipient = await getOrCreateWallet(recipient._id, session);

      if (walletPayer.status !== 'active')     abortarHttp(403, { error: 'Tu wallet no está activa.' });
      if (walletRecipient.status !== 'active') abortarHttp(400, { error: 'La wallet del destinatario no está activa.' });

      // 6. Validar saldo disponible
      const available = Math.max(0, walletPayer.balance - walletPayer.balanceReserved);
      if (available < finalAmount) {
        abortarHttp(400, { error: `Saldo insuficiente. Disponible: Bs. ${available.toFixed(2)}.` });
      }

      // 6-bis. Anti-replay: QR charge/p2p son de un solo uso (deposit es reutilizable
      // por diseño). Si el qrId ya fue cobrado, rechazar el reenvío.
      if (payload.type !== 'deposit' && payload.qrId) {
        const alreadyPaid = await WalletTransaction.exists(
          { 'metadata.qrId': payload.qrId, type: 'send', status: 'completed' },
        ).session(session);
        if (alreadyPaid) abortarHttp(409, { error: 'Este QR ya fue utilizado.' });
      }

      // 7. Operación atómica: débito pagador, crédito receptor
      const prevPayer     = walletPayer.balance;
      const prevRecipient = walletRecipient.balance;

      // Débito condicional: re-verifica saldo disponible EN el update (atómico)
      const debitResult = await WalletBOB.updateOne(
        {
          _id: walletPayer._id,
          $expr: { $gte: [{ $subtract: ['$balance', { $ifNull: ['$balanceReserved', 0] }] }, finalAmount] },
        },
        { $inc: { balance: -finalAmount } },
        { session },
      );
      if (debitResult.modifiedCount !== 1) abortarHttp(400, { error: 'Saldo insuficiente.' });

      await WalletBOB.updateOne(
        { _id: walletRecipient._id },
        { $inc: { balance: finalAmount } },
        { session },
      );

      // 8. Crear WalletTransactions (send + receive)
      const descSend    = payload.description
        ? `QR: ${payload.description}`
        : `Pago QR a ${recipient.firstName} ${recipient.lastName}`;
      const descReceive = `Cobro QR de ${payer.firstName} ${payer.lastName}`;

      const [wtxSend] = await WalletTransaction.create([
        {
          walletId:           walletPayer._id,
          userId:             payer._id,
          type:               'send',
          amount:             finalAmount,
          balanceBefore:      prevPayer,
          balanceAfter:       prevPayer - finalAmount,
          status:             'completed',
          description:        descSend,
          counterpartyUserId: recipient._id,
          metadata:           { qrId: payload.qrId, qrType: payload.type },
          confirmedAt:        new Date(),
        },
        {
          walletId:           walletRecipient._id,
          userId:             recipient._id,
          type:               'receive',
          amount:             finalAmount,
          balanceBefore:      prevRecipient,
          balanceAfter:       prevRecipient + finalAmount,
          status:             'completed',
          description:        descReceive,
          counterpartyUserId: payer._id,
          metadata:           { qrId: payload.qrId, qrType: payload.type },
          confirmedAt:        new Date(),
        },
      ], { session, ordered: true });

      post = {
        asset: 'BOB', recipient, finalAmount,
        wtxId: wtxSend.wtxId, balanceAfter: prevPayer - finalAmount,
      };
    });
  } catch (err) {
    if (err instanceof AbortoDeliberado) return res.status(err.payload.http).json(err.payload.body);
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });

    // WriteConflict que el driver ya reintentó sin éxito — fondos protegidos.
    if (err.code === 112 || err.errorLabels?.includes('TransientTransactionError')) {
      return res.status(409).json({ error: 'Operación concurrente detectada. Intenta de nuevo.' });
    }
    Sentry.captureException(err, { tags: { controller: 'qrWalletController', fn: 'scanAndPayQR', asset } });
    return res.status(500).json({ error: `Error al procesar el pago QR${asset === 'USDC' ? ' USDC' : ''}.` });
  } finally {
    await session.endSession();
  }

  // ── Posterior al commit ───────────────────────────────────────────────────
  const { recipient, finalAmount } = post;

  if (post.asset === 'USDC') {
    const { result } = post;
    fireUSDCAuditTrail(result.wtxSend.wtxId);
    notify(recipient._id, NOTIFICATIONS.usdcReceived(finalAmount, result.senderName)).catch(() => {});
    return res.json({
      success:      true,
      wtxId:        result.wtxSend.wtxId,
      amount:       finalAmount,
      asset:        'USDC',
      recipient:    result.recipientName,
      qrType:       payload.type,
      balanceAfter: result.prevOrigen - result.total,
    });
  }

  // 9. Audit trail Stellar — fire and forget
  fireAuditTrail(post.wtxId, 'qr_pay', finalAmount);

  // 10. Push + in-app notification al receptor — fire and forget
  notify(recipient._id, {
    title: 'Pago recibido',
    body:  `Recibiste Bs. ${finalAmount.toFixed(2)} de ${payer.firstName} ${payer.lastName}`,
    data:  { type: 'qr_payment' },
  }).catch(() => {});

  return res.json({
    success:      true,
    wtxId:        post.wtxId,
    amount:       finalAmount,
    recipient:    `${recipient.firstName} ${recipient.lastName}`,
    qrType:       payload.type,
    balanceAfter: post.balanceAfter,
  });
}

// ── GET /api/v1/wallet/qr/preview ─────────────────────────────────────────────

/**
 * Previsualiza un QR antes de pagar.
 * Valida firma y expiración pero NO realiza ningún movimiento de fondos.
 * Query: ?qrContent=<url-encoded JSON>
 */
export async function previewQR(req, res) {
  try {
    const { qrContent } = req.query;
    if (!qrContent) return res.status(400).json({ error: 'qrContent es requerido.' });

    const { valid, payload, error: qrError } = verifyQR(decodeURIComponent(qrContent));
    if (!valid) return res.status(400).json({ error: qrError });

    return res.json({
      valid:       true,
      qrId:        payload.qrId,
      type:        payload.type,
      asset:       payload.asset ?? 'BOB',
      creatorName: payload.creatorName,
      amount:      payload.amount,
      description: payload.description,
      expiresAt:   payload.expiresAt ? new Date(payload.expiresAt) : null,
    });

  } catch {
    return res.status(400).json({ error: 'QR inválido.' });
  }
}
