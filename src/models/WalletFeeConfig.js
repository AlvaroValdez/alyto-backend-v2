/**
 * WalletFeeConfig.js — Configuración de comisiones de wallet (singleton)
 *
 * Comisiones de operaciones de wallet que NO son cross-border (esas viven en
 * TransactionConfig por corredor). Hoy cubre la transferencia USDC P2P (P3 del
 * plan USDC P2P). Editable desde admin. Arranca DESHABILITADO (comisión 0) para
 * efecto red; se puede activar el cobro sin redeploy.
 *
 * Singleton: _id fijo 'singleton'.
 */

import mongoose from 'mongoose'

const walletFeeConfigSchema = new mongoose.Schema({
  _id: { type: String, default: 'singleton' },

  // ── USDC P2P ────────────────────────────────────────────────────────────────
  /** Si false, la comisión P2P USDC es 0 (default — efecto red). */
  usdcP2pEnabled:           { type: Boolean, default: false },
  /** % sobre el monto (retail). */
  usdcP2pFeePercent:        { type: Number, default: 0, min: 0 },
  /** Comisión fija en USDC (retail). */
  usdcP2pFeeFixed:          { type: Number, default: 0, min: 0 },
  /** Piso de comisión en USDC (0 = sin piso). */
  usdcP2pFeeMin:            { type: Number, default: 0, min: 0 },
  /** Techo de comisión en USDC (null = sin techo). */
  usdcP2pFeeMax:            { type: Number, default: null },
  /** Monto bajo el cual el envío es gratis (0 = sin franja gratis). */
  usdcP2pFreeBelow:         { type: Number, default: 0, min: 0 },
  /** Tarifa diferenciada para cuentas business. */
  businessUsdcP2pFeePercent:{ type: Number, default: 0, min: 0 },
  businessUsdcP2pFeeFixed:  { type: Number, default: 0, min: 0 },

  // ── Límites USDC P2P (0 = sin límite, salvo el mínimo) ───────────────────────
  /** Mínimo por envío en USDC. */
  usdcP2pMinPerTx:          { type: Number, default: 1,     min: 0 },
  /** Máximo por transacción (retail). 0 = sin límite. */
  usdcP2pMaxPerTx:          { type: Number, default: 1000,  min: 0 },
  /** Máximo acumulado diario (retail). 0 = sin límite. */
  usdcP2pMaxDaily:          { type: Number, default: 2000,  min: 0 },
  /** Máximo por transacción (business). */
  businessUsdcP2pMaxPerTx:  { type: Number, default: 5000,  min: 0 },
  /** Máximo acumulado diario (business). */
  businessUsdcP2pMaxDaily:  { type: Number, default: 10000, min: 0 },

  // ── Revenue acumulada (ledger interno) ───────────────────────────────────────
  /** USDC total acumulado por comisiones P2P (cuenta de revenue interna). */
  revenueAccruedUsdc:       { type: Number, default: 0, min: 0 },

  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, collection: 'wallet_fee_configs' })

/** Devuelve el singleton, creándolo con defaults si no existe. */
walletFeeConfigSchema.statics.getSingleton = async function (session) {
  const opts = session ? { session } : {}
  let cfg = await this.findById('singleton', null, opts)
  if (!cfg) {
    const created = await this.create([{ _id: 'singleton' }], opts)
    cfg = created[0]
  }
  return cfg
}

export default mongoose.model('WalletFeeConfig', walletFeeConfigSchema)
