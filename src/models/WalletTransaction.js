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
    enum:     ['deposit', 'withdrawal', 'send', 'receive', 'fee', 'freeze', 'unfreeze'],
    required: true,
  },
  /** Monto en BOB */
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
    enum:    ['pending', 'completed', 'failed', 'reversed'],
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
}, { timestamps: true })

// ─── Índices ──────────────────────────────────────────────────────────────────

walletTransactionSchema.index({ type: 1, status: 1 })
walletTransactionSchema.index({ createdAt: -1 })

export default mongoose.model('WalletTransaction', walletTransactionSchema)
