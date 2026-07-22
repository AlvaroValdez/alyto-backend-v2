/**
 * LedgerAccount.js — Plan de cuentas del Libro Mayor (General Ledger)
 *
 * Capa de contabilidad consolidada de doble entrada (ver
 * docs/PLAN_LIBRO_MAYOR_CONTABILIDAD.md). Cada cuenta tiene una moneda nativa;
 * las cuentas multi-moneda (clearing de conversión, patrimonio) dejan `currency`
 * en null y aceptan líneas de cualquier moneda.
 *
 * El catálogo canónico vive en `ledgerService.CHART_OF_ACCOUNTS` y se materializa
 * con `scripts/seed-chart-of-accounts.mjs` (idempotente por `code`).
 *
 * ⚠️ Capa ADITIVA: no reemplaza WalletBOB/WalletUSDC/Transaction/FundingRecord.
 */

import mongoose from 'mongoose'

const ledgerAccountSchema = new mongoose.Schema({
  /** Código único de cuenta (ej. '2010'). Ver §5 del plan. */
  code:       { type: String, required: true, unique: true, trim: true, index: true },
  name:       { type: String, required: true, trim: true },
  type:       { type: String, required: true, enum: ['asset', 'liability', 'equity', 'income', 'expense'] },
  /** Lado normal del saldo: deudor (asset/expense) o acreedor (liability/equity/income). */
  normalSide: { type: String, required: true, enum: ['debit', 'credit'] },
  /**
   * Moneda nativa. null = cuenta multi-moneda (clearing/patrimonio) que acepta
   * líneas de cualquier moneda — usada para posiciones cross-currency (§6).
   */
  currency:   { type: String, enum: ['BOB', 'USDC', 'USD', 'XLM'], default: null },
  /** Cuenta de control: lleva sub-mayor por dimensión (ej. userId) en JournalLine.dims. */
  isControl:  { type: Boolean, default: false },
  active:     { type: Boolean, default: true },
}, { timestamps: true, collection: 'ledger_accounts' })

export default mongoose.model('LedgerAccount', ledgerAccountSchema)
