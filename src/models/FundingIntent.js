/**
 * FundingIntent.js — Intención de Fondeo de Tesorería (Camino A, H3)
 *
 * Antes de comprar USDC (Binance P2P, etc.) y transferirlo a la wallet de
 * tesorería, el admin crea un "intent" con un correlativo atómico (FND-YYYYMM-N).
 * Ese correlativo se usa como MEMO al retirar desde el exchange y como enlace de
 * trazabilidad. El job `reconcileTreasuryFunding` detecta el inflow on-chain,
 * lo matchea con el intent abierto por memo y lo marca 'matched', creando el
 * FundingRecord confirmado.
 *
 * La dirección de tesorería se segrega de las direcciones custodiales de usuarios
 * (Camino A): todo inflow USDC a la wallet de tesorería que NO sea depósito de
 * usuario (memo ALYTO-) es fondeo.
 *
 * Estados:
 *   open      — creado, esperando el inflow on-chain
 *   matched   — reconciliado con un FundingRecord confirmado
 *   cancelled — anulado por el admin
 *   expired   — (reservado) sin uso futuro
 */

import mongoose from 'mongoose'

const fundingIntentSchema = new mongoose.Schema({
  /** Correlativo atómico: FND-YYYYMM-NNNNNN (Counter, prefijo 'FND') */
  intentId:        { type: String, required: true, unique: true, trim: true },
  entity:          { type: String, enum: ['LLC', 'SpA', 'SRL'], default: 'SRL' },
  asset:           { type: String, enum: ['USDC', 'USDT'], default: 'USDC' },
  /** Dirección Stellar de tesorería donde debe llegar el fondeo */
  treasuryAddress: { type: String, required: true },
  /** Memo correlativo (= intentId) para desambiguar el inflow */
  memo:            { type: String, required: true, trim: true },
  /** Monto USDC esperado (opcional — la verdad es el monto on-chain) */
  expectedAmount:  { type: Number, default: null, min: 0 },
  /** Origen del fondeo (trazabilidad ASFI) */
  sourceCurrency:  { type: String, default: null, uppercase: true, trim: true },
  sourceAmount:    { type: Number, default: null, min: 0 },
  binanceOrderId:  { type: String, default: null, trim: true },
  note:            { type: String, default: null, trim: true },

  status:          { type: String, enum: ['open', 'matched', 'cancelled', 'expired'], default: 'open' },

  /** Enlace al FundingRecord creado al reconciliar */
  matchedFundingId:   { type: String, default: null },
  matchedStellarTxId: { type: String, default: null },
  matchedAmount:      { type: Number, default: null },
  matchedAt:          { type: Date,   default: null },

  createdBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true, collection: 'funding_intents' })

fundingIntentSchema.index({ status: 1, memo: 1 })
fundingIntentSchema.index({ entity: 1, createdAt: -1 })

export default mongoose.model('FundingIntent', fundingIntentSchema)
