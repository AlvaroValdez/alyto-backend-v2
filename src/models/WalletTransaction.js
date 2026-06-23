/**
 * WalletTransaction.js — Registro de movimientos de la Wallet BOB
 *
 * Cada operación sobre WalletBOB genera una WalletTransaction.
 * Incluye balanceBefore/balanceAfter para auditoría completa (exigencia ASFI).
 *
 * El campo stellarTxId se completa una vez que el audit trail on-chain
 * se registra en Stellar. Puede ser null si Stellar falló (best-effort).
 */

import mongoose from 'mongoose'
import crypto  from 'crypto'

function shortId(len = 6) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len).toUpperCase()
}

const walletTransactionSchema = new mongoose.Schema({
  wtxId: {
    type:    String,
    default: () => `WTX-${Date.now()}-${shortId(6)}`,
    unique:  true,
    index:   true,
  },
  walletId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'WalletBOB',
    required: true,
    index:    true,
  },
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },
  type: {
    type:     String,
    enum:     ['deposit', 'withdrawal', 'send', 'receive', 'fee', 'freeze', 'unfreeze',
               'bob_to_usdc', 'usdc_to_bob', 'usdc_deposit'],
    required: true,
  },
  /**
   * Moneda de la transacción. Default 'BOB' para compatibilidad con registros anteriores.
   * Usar 'USDC' para transacciones de WalletUSDC.
   */
  currency: {
    type:    String,
    enum:    ['BOB', 'USDC'],
    default: 'BOB',
  },
  /**
   * Modelo de wallet referenciado por walletId.
   * Default 'WalletBOB' para compatibilidad. Usar 'WalletUSDC' para USDC.
   */
  walletModel: {
    type:    String,
    enum:    ['WalletBOB', 'WalletUSDC'],
    default: 'WalletBOB',
  },
  /** Monto en la moneda indicada por `currency` */
  amount: {
    type:     Number,
    required: true,
    min:      0,
  },
  /** Saldo antes de la operación — para auditoría ASFI */
  balanceBefore: {
    type:     Number,
    required: true,
  },
  /** Saldo después de la operación */
  balanceAfter: {
    type:     Number,
    required: true,
  },
  status: {
    type:    String,
    // 'awaiting_proof' = depósito iniciado sin comprobante (manual) o sin QR válido
    // (bankQr) — NO acreditable ni visible en la cola admin hasta que se adjunte el
    // comprobante o el banco devuelva un QR válido. Pasa a 'pending' recién entonces.
    // 'dispatched' = retiro enviado a dispersión bancaria (BANECO §9 Planillas) y a la
    // espera de la confirmación notifyStatus (ACEP→completed / RECH→failed). El saldo
    // sigue reservado hasta que el banco confirme.
    enum:    ['awaiting_proof', 'pending', 'dispatched', 'completed', 'failed', 'reversed'],
    default: 'pending',
  },
  /** Referencia bancaria o wtxId usado como concepto de transferencia */
  reference: {
    type:    String,
    default: null,
    index:   true,
  },
  /** TXID de Stellar — se completa tras registrar el audit trail on-chain */
  stellarTxId: {
    type:    String,
    default: null,
  },
  description: {
    type:    String,
    default: null,
  },
  /** Datos adicionales: datos bancarios de retiro, referencia de banco, etc. */
  metadata: {
    type:    mongoose.Schema.Types.Mixed,
    default: {},
  },
  /** Para operaciones P2P: el otro usuario de la operación */
  counterpartyUserId: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'User',
    default: null,
  },
  /** Admin que confirmó la operación (depósitos y retiros manuales) */
  confirmedBy: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'User',
    default: null,
  },
  confirmedAt: {
    type:    Date,
    default: null,
  },
  /** Fecha de expiración para operaciones pending que admin no confirmó a tiempo */
  expiresAt: {
    type:    Date,
    default: null,
  },
  /**
   * Metadatos del QR bancario (payin automático bankQr, Fase 42 — extendido a la
   * carga de Wallet BOB). Solo presente en depósitos pagados por QR del banco.
   * La confirmación es automática vía IPN / job de reconciliación — sin admin.
   */
  bankQr: {
    type: new mongoose.Schema({
      bankId:  { type: String, trim: true },              // 'bec' | 'bnb' | ...
      qrId:    { type: String, trim: true },              // ID único del QR en el banco
      dueDate: { type: String },                          // 'yyyy-MM-dd' (vencimiento)
      paidAt:  { type: Date },                            // timestamp de confirmación
      payment: { type: mongoose.Schema.Types.Mixed },     // objeto PaymentQR del banco
    }, { _id: false }),
    default: undefined,
  },
}, { timestamps: true, collection: 'wallettransactions' })

// ─── Índices ──────────────────────────────────────────────────────────────────

walletTransactionSchema.index({ type: 1, status: 1 })
walletTransactionSchema.index({ createdAt: -1 })
// Lookup por QR bancario (IPN + job de reconciliación). Sparse: solo depósitos bankQr.
walletTransactionSchema.index({ 'bankQr.qrId': 1 }, { sparse: true })

export default mongoose.model('WalletTransaction', walletTransactionSchema)
