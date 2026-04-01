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
import { sendPushNotification }        from '../services/notifications.js';
import { getOrCreateWallet, fireAuditTrail } from './walletController.js';
import Sentry            from '../services/sentry.js';

// ── POST /api/v1/wallet/qr/generate ──────────────────────────────────────────

/**
 * Genera un QR Alyto firmado.
 * Body: { type, amount?, description?, expiresInSecs? }
 */
export async function generateWalletQR(req, res) {
  try {
    const { type, amount, description, expiresInSecs } = req.body;
    const user = req.user;

    if (user.legalEntity !== 'SRL') {
      return res.status(403).json({ error: 'QR Wallet exclusivo para usuarios Bolivia (SRL).' });
    }
    if (user.kycStatus !== 'approved') {
      return res.status(403).json({ error: 'KYC requerido para usar QR Wallet.' });
    }

    // Para charge/p2p verificar que la wallet existe y está activa
    if (type === 'charge' || type === 'p2p') {
      const wallet = await WalletBOB.findOne({ userId: user._id }).lean();
      if (!wallet || wallet.status !== 'active') {
        return res.status(403).json({ error: 'Tu wallet no está activa.' });
      }
    }

    const result = await generateQR({
      type,
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
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const payer = req.user;
    const { qrContent, amount: overrideAmount } = req.body;

    if (payer.legalEntity !== 'SRL') {
      await session.abortTransaction();
      return res.status(403).json({ error: 'QR Wallet exclusivo para usuarios Bolivia (SRL).' });
    }
    if (payer.kycStatus !== 'approved') {
      await session.abortTransaction();
      return res.status(403).json({ error: 'KYC requerido.' });
    }
    if (!qrContent) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'qrContent es requerido.' });
    }

    // 1. Verificar QR (firma + expiración)
    const { valid, payload, error: qrError } = verifyQR(qrContent);
    if (!valid) {
      await session.abortTransaction();
      return res.status(400).json({ error: qrError });
    }

    // 2. No permitir autopago
    if (payload.creatorUserId === payer._id.toString()) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'No puedes pagarte a ti mismo.' });
    }

    // 3. Determinar monto final
    // deposit → el pagador elige el monto (overrideAmount)
    // charge/p2p → el monto está fijo en el QR
    const finalAmount = payload.type === 'deposit'
      ? Number(overrideAmount)
      : Number(payload.amount);

    if (!finalAmount || finalAmount < 1) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'Monto inválido. Mínimo Bs. 1.' });
    }

    // 4. Buscar receptor
    const recipient = await User.findById(payload.creatorUserId).lean();
    if (!recipient || recipient.legalEntity !== 'SRL') {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Destinatario no encontrado.' });
    }

    // 5. Obtener wallets (crear si no existen)
    const [walletPayer, walletRecipient] = await Promise.all([
      getOrCreateWallet(payer._id, session),
      getOrCreateWallet(recipient._id, session),
    ]);

    if (walletPayer.status !== 'active') {
      await session.abortTransaction();
      return res.status(403).json({ error: 'Tu wallet no está activa.' });
    }
    if (walletRecipient.status !== 'active') {
      await session.abortTransaction();
      return res.status(400).json({ error: 'La wallet del destinatario no está activa.' });
    }

    // 6. Validar saldo disponible
    const available = Math.max(0, walletPayer.balance - walletPayer.balanceReserved);
    if (available < finalAmount) {
      await session.abortTransaction();
      return res.status(400).json({
        error: `Saldo insuficiente. Disponible: Bs. ${available.toFixed(2)}.`,
      });
    }

    // 7. Operación atómica: débito pagador, crédito receptor
    const prevPayer     = walletPayer.balance;
    const prevRecipient = walletRecipient.balance;

    await WalletBOB.updateOne(
      { _id: walletPayer._id },
      { $inc: { balance: -finalAmount } },
      { session },
    );
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

    const [wtxSend, wtxReceive] = await WalletTransaction.create([
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
    ], { session });

    await session.commitTransaction();

    // 9. Audit trail Stellar — fire and forget
    fireAuditTrail(wtxSend.wtxId, 'qr_pay', finalAmount);

    // 10. Push notification al receptor — fire and forget
    sendPushNotification(recipient._id, {
      title: 'Pago recibido',
      body:  `Recibiste Bs. ${finalAmount.toFixed(2)} de ${payer.firstName} ${payer.lastName}`,
    }).catch(() => {});

    return res.json({
      success:      true,
      wtxId:        wtxSend.wtxId,
      amount:       finalAmount,
      recipient:    `${recipient.firstName} ${recipient.lastName}`,
      qrType:       payload.type,
      balanceAfter: prevPayer - finalAmount,
    });

  } catch (err) {
    await session.abortTransaction();
    Sentry.captureException(err, { tags: { controller: 'qrWalletController', fn: 'scanAndPayQR' } });
    return res.status(500).json({ error: 'Error al procesar el pago QR.' });
  } finally {
    session.endSession();
  }
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
      creatorName: payload.creatorName,
      amount:      payload.amount,
      description: payload.description,
      expiresAt:   payload.expiresAt ? new Date(payload.expiresAt) : null,
    });

  } catch {
    return res.status(400).json({ error: 'QR inválido.' });
  }
}
