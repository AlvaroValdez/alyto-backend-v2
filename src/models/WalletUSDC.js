/**
 * WalletUSDC.js — Wallet con Saldo USDC (Dual Ledger Bolivia — Fase 35)
 *
 * Complementa WalletBOB con una capa USDC on-chain sobre Stellar.
 * Permite a usuarios SRL mantener saldo en USDC tras convertir desde BOB
 * o al recibir depósitos USDC directamente a su dirección Stellar.
 *
 * Arquitectura Dual Ledger:
 *   - Capa off-chain: este modelo administra saldos USDC en MongoDB
 *   - Capa on-chain:  Stellar registra cada movimiento como audit trail
 *
 * EXCLUSIVO para usuarios con legalEntity === 'SRL' (AV Finance SRL Bolivia).
 *
 * Campos de saldo:
 *   balance         — saldo USDC disponible para operar
 *   balanceFrozen   — saldo congelado por compliance ASFI/UIF (solo admin)
 *   balanceReserved — saldo reservado en conversiones pendientes
 *   balanceAvailable (virtual) = balance - balanceReserved
 *
 * Depósito directo Stellar:
 *   stellarAddress — dirección Stellar compartida de AV Finance SRL
 *   stellarMemo    — memo único del usuario para identificar depósitos
 */

import mongoose from 'mongoose'
import crypto   from 'crypto'

function shortId(len = 6) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len).toUpperCase()
}

const walletUSDCSchema = new mongoose.Schema({
  walletId: {
    type:    String,
    default: () => `WUSDC-${Date.now()}-${shortId(6)}`,
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
  /** Inmutable — siempre USDC */
  currency: {
    type:      String,
    default:   'USDC',
    immutable: true,
  },
  /** Saldo USDC disponible (no incluye reservado) */
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
  /** Saldo reservado en conversiones BOB→USDC pendientes de confirmación */
  balanceReserved: {
    type:    Number,
    default: 0,
    min:     0,
  },
  /**
   * Dirección Stellar donde el usuario puede recibir USDC.
   * En Phase 35 es la dirección de tesorería SRL compartida (STELLAR_SRL_PUBLIC_KEY).
   * En Phase 36+ cada usuario tendrá su propia cuenta Stellar.
   */
  stellarAddress: {
    type:    String,
    default: null,
  },
  /**
   * Memo Stellar único por usuario — identifica sus depósitos en la
   * cuenta compartida. Formato: ALYTO-{shortId}
   * El usuario DEBE incluir este memo al transferir USDC.
   */
  stellarMemo: {
    type:    String,
    default: null,
    index:   true,
  },
  status: {
    type:    String,
    enum:    ['active', 'frozen', 'suspended'],
    default: 'active',
  },
  frozenReason: {
    type:    String,
    default: null,
  },
  frozenAt: {
    type:    Date,
    default: null,
  },
  frozenBy: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'User',
    default: null,
  },
}, { timestamps: true })

// ─── Virtual: saldo disponible real ──────────────────────────────────────────

walletUSDCSchema.virtual('balanceAvailable').get(function () {
  return Math.max(0, this.balance - this.balanceReserved)
})

// ─── Índices ──────────────────────────────────────────────────────────────────

walletUSDCSchema.index({ status: 1 })
walletUSDCSchema.index({ legalEntity: 1 })
walletUSDCSchema.index({ stellarMemo: 1 }, { unique: true, sparse: true })

export default mongoose.model('WalletUSDC', walletUSDCSchema)
