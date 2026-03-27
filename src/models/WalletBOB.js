/**
 * WalletBOB.js — Wallet con Saldo BOB (Dual Ledger Bolivia)
 *
 * Fase 25 — Arquitectura Dual Ledger:
 *   - Capa off-chain: este modelo administra saldos en BOB
 *   - Capa on-chain:  Stellar registra cada movimiento como audit trail
 *
 * EXCLUSIVO para usuarios con legalEntity === 'SRL' (AV Finance SRL Bolivia).
 * No aplica a SpA (Chile) ni LLC (Delaware).
 *
 * Campos de saldo:
 *   balance         — saldo disponible para operar
 *   balanceFrozen   — saldo congelado por compliance ASFI/UIF (solo admin)
 *   balanceReserved — saldo reservado en retiros pendientes de confirmación
 *   balanceAvailable (virtual) = balance - balanceReserved
 */

import mongoose from 'mongoose'
import { nanoid } from 'nanoid'

const walletBOBSchema = new mongoose.Schema({
  walletId: {
    type:    String,
    default: () => `WAL-SRL-${Date.now()}-${nanoid(6).toUpperCase()}`,
    unique:  true,
    index:   true,
  },
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    unique:   true,
    index:    true,
  },
  /** Inmutable — esta wallet solo existe para SRL */
  legalEntity: {
    type:      String,
    default:   'SRL',
    immutable: true,
  },
  /** Inmutable — siempre BOB */
  currency: {
    type:      String,
    default:   'BOB',
    immutable: true,
  },
  /** Saldo disponible en BOB (no incluye reservado) */
  balance: {
    type:    Number,
    default: 0,
    min:     0,
  },
  /** Saldo congelado por orden ASFI/UIF — solo admin puede modificar */
  balanceFrozen: {
    type:    Number,
    default: 0,
    min:     0,
  },
  /** Saldo reservado en retiros pendientes de confirmación manual */
  balanceReserved: {
    type:    Number,
    default: 0,
    min:     0,
  },
  /** Public key Stellar asociada a este usuario — para audit trail */
  stellarPublicKey: {
    type:    String,
    default: null,
  },
  /** Indica si el usuario tiene trustline USDC activa en Stellar */
  trustlineEstablished: {
    type:    Boolean,
    default: false,
  },
  status: {
    type:    String,
    enum:    ['active', 'frozen', 'suspended'],
    default: 'active',
  },
  /** Motivo del congelamiento (obligatorio al congelar) */
  frozenReason: {
    type:    String,
    default: null,
  },
  frozenAt: {
    type:    Date,
    default: null,
  },
  /** Admin que ejecutó el congelamiento */
  frozenBy: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'User',
    default: null,
  },
}, { timestamps: true })

// ─── Virtual: saldo disponible real ──────────────────────────────────────────

walletBOBSchema.virtual('balanceAvailable').get(function () {
  return Math.max(0, this.balance - this.balanceReserved)
})

// ─── Índices ──────────────────────────────────────────────────────────────────

walletBOBSchema.index({ status: 1 })
walletBOBSchema.index({ legalEntity: 1 })

export default mongoose.model('WalletBOB', walletBOBSchema)
