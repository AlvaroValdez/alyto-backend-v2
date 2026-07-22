/**
 * JournalLine.js — Línea (pata) de un asiento del Libro Mayor
 *
 * Cada línea afecta UNA cuenta en UNA moneda, por débito o crédito (exactamente
 * uno > 0). El balanceo por moneda (Σdébito = Σcrédito) se valida en
 * ledgerService.assertBalanced antes de persistir.
 *
 * `dims` es el sub-mayor: en cuentas de control (ej. 2010 Saldos usuarios) permite
 * desglosar por userId sin explotar el catálogo de cuentas.
 */

import mongoose from 'mongoose'

const journalLineSchema = new mongoose.Schema({
  entryId:  { type: String, required: true, index: true },   // ref JournalEntry.entryId
  /** Denormalizado del asiento para consultas por entidad sin join. */
  entity:   { type: String, required: true, enum: ['LLC', 'SpA', 'SRL'] },
  account:  { type: String, required: true, trim: true },    // ref LedgerAccount.code
  currency: { type: String, required: true, enum: ['BOB', 'USDC', 'USD', 'XLM'] },
  debit:    { type: Number, default: 0, min: 0 },
  credit:   { type: Number, default: 0, min: 0 },

  // ── Dimensiones del sub-mayor (evita explosión de cuentas) ────────────────────
  dims: {
    userId:             { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    counterpartyUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    corridorId:         { type: String, default: null },
    /** wtxId / alytoTransactionId / stellarTxHash para rastrear la línea al evento. */
    sourceTxId:         { type: String, default: null },
  },
}, { timestamps: true, collection: 'journal_lines' })

// Balance por cuenta (mayor) y sub-mayor por usuario en cuentas de control.
journalLineSchema.index({ account: 1, currency: 1 })
journalLineSchema.index({ 'dims.userId': 1, account: 1 })
journalLineSchema.index({ entity: 1, createdAt: -1 })

export default mongoose.model('JournalLine', journalLineSchema)
