/**
 * JournalEntry.js — Asiento contable (cabecera) del Libro Mayor
 *
 * Un asiento agrupa 2+ líneas (JournalLine) que balancean por moneda. Se postea
 * DENTRO de la sesión atómica del evento de dinero que lo origina (ver
 * ledgerService.postEntry). Ver docs/PLAN_LIBRO_MAYOR_CONTABILIDAD.md.
 *
 * Idempotencia dura: índice único `(sourceType, sourceRef, posturePurpose)`.
 * Repostear el mismo evento (reintento, backfill) NO duplica el asiento.
 *
 * Correcciones: los asientos NUNCA se editan. Un error se corrige con un asiento
 * de reversa (storno) que apunta a `reversalOf`.
 */

import mongoose from 'mongoose'

const journalEntrySchema = new mongoose.Schema({
  /** Correlativo atómico legible: JE-YYYYMM-NNNNNN. */
  entryId:        { type: String, required: true, unique: true, trim: true, index: true },
  date:           { type: Date, required: true, default: Date.now },
  entity:         { type: String, required: true, enum: ['LLC', 'SpA', 'SRL'] },
  description:    { type: String, default: '', trim: true },

  // ── Trazabilidad al evento origen + idempotencia ──────────────────────────────
  /** Qué originó el asiento. 'manual' = ajuste manual (sin dedupe). */
  sourceType:     { type: String, required: true, enum: ['wallet_tx', 'transaction', 'funding_record', 'fx_conversion', 'manual'] },
  /** Referencia del origen: wtxId / alytoTransactionId / fundingId. En 'manual' = el propio entryId. */
  sourceRef:      { type: String, required: true, trim: true },
  /** Discrimina múltiples asientos de un mismo origen (ej. 'reserve' vs 'settle'). */
  posturePurpose: { type: String, required: true, default: 'default', trim: true },

  /** Quién posteó: userId (string) o 'system'. */
  postedBy:       { type: String, default: 'system' },
  /** entryId del asiento reversado por este (storno). null si no es reversa. */
  reversalOf:     { type: String, default: null },
  status:         { type: String, enum: ['posted', 'reversed'], default: 'posted' },
}, { timestamps: true, collection: 'journal_entries' })

// Idempotencia: un evento (origen + propósito) produce UN asiento.
journalEntrySchema.index({ sourceType: 1, sourceRef: 1, posturePurpose: 1 }, { unique: true })
journalEntrySchema.index({ entity: 1, date: -1 })

export default mongoose.model('JournalEntry', journalEntrySchema)
