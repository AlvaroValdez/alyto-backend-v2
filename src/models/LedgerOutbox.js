/**
 * LedgerOutbox.js — Backstop de posteo del Libro Mayor
 *
 * El posteo del asiento ocurre en la MISMA sesión atómica del evento de dinero
 * (ledgerService.postEntry); si falla, la operación hace rollback. Para el caso
 * extremo en que un flujo no pueda ampliar su sesión, ese flujo puede registrar
 * en su lugar un "intent de posteo" aquí (mismo commit) y un job idempotente
 * (Fase 2) lo postea después. Mientras nadie lo produzca, esta colección queda
 * vacía — es una red de seguridad, no la vía principal.
 *
 * Idempotencia: mismo `(sourceType, sourceRef, posturePurpose)` que JournalEntry.
 */

import mongoose from 'mongoose'

const ledgerOutboxSchema = new mongoose.Schema({
  sourceType:     { type: String, required: true, enum: ['wallet_tx', 'transaction', 'funding_record', 'fx_conversion', 'manual'] },
  sourceRef:      { type: String, required: true, trim: true },
  posturePurpose: { type: String, required: true, default: 'default', trim: true },
  entity:         { type: String, required: true, enum: ['LLC', 'SpA', 'SRL'] },
  /** Payload para postEntry: { date, description, lines }. */
  payload:        { type: mongoose.Schema.Types.Mixed, required: true },

  status:         { type: String, enum: ['pending', 'posted', 'failed'], default: 'pending', index: true },
  attempts:       { type: Number, default: 0 },
  lastError:      { type: String, default: null },
  /** entryId del asiento creado al drenar el outbox. */
  postedEntryId:  { type: String, default: null },
}, { timestamps: true, collection: 'ledger_outbox' })

ledgerOutboxSchema.index({ sourceType: 1, sourceRef: 1, posturePurpose: 1 }, { unique: true })

export default mongoose.model('LedgerOutbox', ledgerOutboxSchema)
