/**
 * ledgerService.js — Motor del Libro Mayor (General Ledger) de doble entrada
 *
 * Capa ADITIVA de contabilidad consolidada. No reemplaza los sub-ledgers
 * existentes (WalletBOB/USDC, Transaction, FundingRecord): los ACOMPAÑA, posteando
 * un asiento balanceado desde cada evento de dinero, dentro de su misma sesión
 * atómica. Ver docs/PLAN_LIBRO_MAYOR_CONTABILIDAD.md.
 *
 * Este archivo expone:
 *   - CHART_OF_ACCOUNTS  — catálogo canónico (seed + validación)
 *   - assertBalanced / summarizeByCurrency / assertAccountsKnown  — puros, testeables
 *   - postEntry(entry, session)  — postea un asiento (idempotente, atómico)
 *
 * FASE 0: nada de esto está enganchado a los flujos de dinero todavía. Se activa
 * por bloques detrás del flag LEDGER_POSTING_ENABLED (Fase 2).
 */

import mongoose from 'mongoose'
import LedgerAccount from '../models/LedgerAccount.js'
import JournalEntry  from '../models/JournalEntry.js'
import JournalLine   from '../models/JournalLine.js'
import Counter       from '../models/Counter.js'
import { logger }    from '../utils/logger.js'

/** Tolerancia de balanceo (absorbe redondeo float; USDC tiene 7 decimales on-chain). */
const BALANCE_EPSILON = 1e-6

/** Error de dominio del ledger — separa fallos de validación contable de otros. */
export class LedgerError extends Error {
  constructor(message) { super(message); this.name = 'LedgerError' }
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAN DE CUENTAS CANÓNICO (§5 del plan) — moneda null = multi-moneda
// ═══════════════════════════════════════════════════════════════════════════

export const CHART_OF_ACCOUNTS = [
  // ── Activos (deudor) ──
  { code: '1010', name: 'Tesorería USDC on-chain (SRL)',     type: 'asset',     normalSide: 'debit',  currency: 'USDC' },
  { code: '1015', name: 'Channel account XLM (Fee Bump)',    type: 'asset',     normalSide: 'debit',  currency: 'XLM'  },
  { code: '1020', name: 'Custodia USDC usuarios on-chain',   type: 'asset',     normalSide: 'debit',  currency: 'USDC' },
  { code: '1030', name: 'Caja/Banco BOB (Banco Económico)',  type: 'asset',     normalSide: 'debit',  currency: 'BOB'  },
  { code: '1040', name: 'Vita Wallet (saldo operativo)',     type: 'asset',     normalSide: 'debit',  currency: 'USD'  },
  { code: '1050', name: 'USDC en tránsito a Harbor',         type: 'asset',     normalSide: 'debit',  currency: 'USDC' },
  { code: '1090', name: 'Clearing de conversión',            type: 'asset',     normalSide: 'debit',  currency: null   },
  // ── Pasivos (acreedor) ──
  { code: '2010', name: 'Saldos BOB usuarios',               type: 'liability', normalSide: 'credit', currency: 'BOB',  isControl: true },
  { code: '2011', name: 'Saldos BOB congelados',             type: 'liability', normalSide: 'credit', currency: 'BOB',  isControl: true },
  { code: '2012', name: 'Saldos BOB reservados',             type: 'liability', normalSide: 'credit', currency: 'BOB',  isControl: true },
  { code: '2020', name: 'Saldos USDC usuarios',              type: 'liability', normalSide: 'credit', currency: 'USDC', isControl: true },
  { code: '2021', name: 'Saldos USDC congelados',            type: 'liability', normalSide: 'credit', currency: 'USDC', isControl: true },
  { code: '2022', name: 'Saldos USDC reservados',            type: 'liability', normalSide: 'credit', currency: 'USDC', isControl: true },
  { code: '2030', name: 'Obligación de payout cross-border', type: 'liability', normalSide: 'credit', currency: 'USDC', isControl: true },
  // ── Ingresos (acreedor) ──
  { code: '4010', name: 'Comisión payin',                    type: 'income',    normalSide: 'credit', currency: 'BOB'  },
  { code: '4020', name: 'Spread FX cross-border',            type: 'income',    normalSide: 'credit', currency: 'BOB'  },
  { code: '4030', name: 'Comisión fija',                     type: 'income',    normalSide: 'credit', currency: 'BOB'  },
  { code: '4040', name: 'Retención de utilidad',             type: 'income',    normalSide: 'credit', currency: 'BOB'  },
  { code: '4050', name: 'Comisión P2P USDC',                 type: 'income',    normalSide: 'credit', currency: 'USDC' },
  { code: '4060', name: 'Spread de conversión swap',         type: 'income',    normalSide: 'credit', currency: 'BOB'  },
  // ── Gastos (deudor) ──
  { code: '5010', name: 'Costo payout Vita',                 type: 'expense',   normalSide: 'debit',  currency: 'USD'  },
  { code: '5020', name: 'Costo payout Harbor',               type: 'expense',   normalSide: 'debit',  currency: 'USDC' },
  { code: '5030', name: 'Fees de red Stellar',               type: 'expense',   normalSide: 'debit',  currency: 'XLM'  },
  { code: '5040', name: 'Costo de fondeo (spread Binance)',  type: 'expense',   normalSide: 'debit',  currency: 'BOB'  },
  // ── Patrimonio ──
  { code: '3010', name: 'Aportes / capital de tesorería',    type: 'equity',    normalSide: 'credit', currency: null   },
  { code: '3090', name: 'Resultados acumulados',             type: 'equity',    normalSide: 'credit', currency: null   },
]

/** Índice code → cuenta, para validación O(1). */
const ACCOUNT_INDEX = new Map(CHART_OF_ACCOUNTS.map(a => [a.code, a]))

/** @returns {object|undefined} definición de cuenta del catálogo canónico. */
export function getAccountDef(code) {
  return ACCOUNT_INDEX.get(code)
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNCIONES PURAS (testeables sin DB ni red)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Agrupa débitos y créditos por moneda. Base del chequeo de balanceo y de los
 * reportes por moneda.
 * @param {Array<{currency:string, debit?:number, credit?:number}>} lines
 * @returns {Object<string,{debit:number,credit:number}>}
 */
export function summarizeByCurrency(lines) {
  const acc = {}
  for (const l of lines) {
    const cur = l.currency
    if (!acc[cur]) acc[cur] = { debit: 0, credit: 0 }
    acc[cur].debit  += Number(l.debit)  || 0
    acc[cur].credit += Number(l.credit) || 0
  }
  return acc
}

/**
 * Valida que un conjunto de líneas forme un asiento de doble entrada correcto:
 *   - al menos 2 líneas
 *   - cada línea con moneda y exactamente uno de debit/credit > 0 (sin negativos)
 *   - Σdébito = Σcrédito POR MONEDA (las conversiones cross-currency balancean
 *     en cada moneda por separado; la posición FX vive en la cuenta clearing 1090)
 * @throws {LedgerError}
 * @returns {true}
 */
export function assertBalanced(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new LedgerError('un asiento requiere al menos 2 líneas')
  }
  for (const l of lines) {
    const d = Number(l.debit) || 0
    const c = Number(l.credit) || 0
    if (!l.currency) throw new LedgerError(`línea sin moneda (cuenta ${l.account ?? '?'})`)
    if (d < 0 || c < 0) throw new LedgerError(`monto negativo en línea (cuenta ${l.account ?? '?'})`)
    if ((d > 0) === (c > 0)) {
      throw new LedgerError(`cada línea debe tener exactamente uno de debit/credit > 0 (cuenta ${l.account ?? '?'})`)
    }
  }
  const byCur = summarizeByCurrency(lines)
  for (const [cur, { debit, credit }] of Object.entries(byCur)) {
    if (Math.abs(debit - credit) > BALANCE_EPSILON) {
      throw new LedgerError(`asiento descuadrado en ${cur}: débito ${debit} ≠ crédito ${credit}`)
    }
  }
  return true
}

/**
 * Valida que toda línea use una cuenta conocida del catálogo y que su moneda
 * coincida con la de la cuenta (salvo cuentas multi-moneda, currency=null).
 * @throws {LedgerError}
 * @returns {true}
 */
export function assertAccountsKnown(lines) {
  for (const l of lines) {
    const def = ACCOUNT_INDEX.get(l.account)
    if (!def) throw new LedgerError(`cuenta desconocida: ${l.account}`)
    if (def.currency != null && def.currency !== l.currency) {
      throw new LedgerError(`moneda de la línea (${l.currency}) ≠ moneda de la cuenta ${l.account} (${def.currency})`)
    }
  }
  return true
}

// ═══════════════════════════════════════════════════════════════════════════
// POSTEO (requiere DB — se ejecuta dentro de la sesión del evento)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Genera el siguiente entryId (JE-YYYYMM-NNNNNN) usando el Counter atómico DENTRO
 * de la sesión: si la transacción aborta, el $inc se revierte y no quedan huecos.
 */
async function nextEntryId(session) {
  const now    = new Date()
  const period = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  const key    = `JE-${period}`
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session: session ?? undefined },
  )
  return `${key}-${String(doc.seq).padStart(6, '0')}`
}

/**
 * Postea un asiento contable. Idempotente por (sourceType, sourceRef, purpose):
 * repostear el mismo evento devuelve el asiento existente sin duplicar.
 *
 * DEBE llamarse dentro de la sesión atómica del evento de dinero (o sin sesión en
 * backfill/manual). El posteo es parte de la transacción: si falla, la operación
 * hace rollback — la contabilidad nunca queda a medias.
 *
 * @param {object} entry
 * @param {'LLC'|'SpA'|'SRL'} entry.entity
 * @param {'wallet_tx'|'transaction'|'funding_record'|'fx_conversion'|'manual'} entry.sourceType
 * @param {string} [entry.sourceRef]  requerido salvo sourceType='manual'
 * @param {string} [entry.posturePurpose='default']
 * @param {Array<{account,currency,debit?,credit?,dims?}>} entry.lines
 * @param {Date}   [entry.date]
 * @param {string} [entry.description]
 * @param {string} [entry.postedBy='system']
 * @param {import('mongoose').ClientSession} [session]
 * @returns {Promise<import('mongoose').Document>} el JournalEntry (nuevo o existente)
 */
export async function postEntry(entry, session) {
  const {
    entity, sourceType, sourceRef, posturePurpose = 'default',
    lines, date, description = '', postedBy = 'system',
  } = entry

  if (!['LLC', 'SpA', 'SRL'].includes(entity)) throw new LedgerError(`entity inválido: ${entity}`)
  assertBalanced(lines)
  assertAccountsKnown(lines)

  const isManual = sourceType === 'manual'
  if (!isManual && !sourceRef) throw new LedgerError(`sourceRef requerido para sourceType='${sourceType}'`)

  // Idempotencia: eventos ya posteados devuelven el asiento existente (no-op).
  if (!isManual) {
    const existing = await JournalEntry.findOne({ sourceType, sourceRef, posturePurpose }).session(session ?? null)
    if (existing) return existing
  }

  const entryId = await nextEntryId(session)
  const finalSourceRef = isManual ? entryId : sourceRef

  let created
  try {
    const [doc] = await JournalEntry.create([{
      entryId, date: date ?? new Date(), entity, description,
      sourceType, sourceRef: finalSourceRef, posturePurpose, postedBy, status: 'posted',
    }], { session: session ?? undefined })
    created = doc
  } catch (err) {
    // Carrera concurrente: el índice único ganó por el otro request. Devolver el suyo.
    if (err?.code === 11000 && !isManual) {
      const winner = await JournalEntry.findOne({ sourceType, sourceRef, posturePurpose }).session(session ?? null)
      if (winner) return winner
    }
    throw err
  }

  const lineDocs = lines.map(l => ({
    entryId,
    entity,
    account:  l.account,
    currency: l.currency,
    debit:    Number(l.debit)  || 0,
    credit:   Number(l.credit) || 0,
    dims:     l.dims ?? {},
  }))
  await JournalLine.insertMany(lineDocs, { session: session ?? undefined })

  logger.info?.('[ledger] asiento posteado', { entryId, entity, sourceType, sourceRef: finalSourceRef, lines: lineDocs.length })
  return created
}

/** Sincroniza el catálogo de cuentas en DB (idempotente por code). Usado por el seed. */
export async function syncChartOfAccounts() {
  let created = 0, updated = 0
  for (const a of CHART_OF_ACCOUNTS) {
    const res = await LedgerAccount.updateOne(
      { code: a.code },
      { $set: { name: a.name, type: a.type, normalSide: a.normalSide, currency: a.currency ?? null, isControl: !!a.isControl, active: true } },
      { upsert: true },
    )
    if (res.upsertedCount) created++
    else if (res.modifiedCount) updated++
  }
  return { total: CHART_OF_ACCOUNTS.length, created, updated }
}

export default { postEntry, assertBalanced, assertAccountsKnown, summarizeByCurrency, syncChartOfAccounts, CHART_OF_ACCOUNTS, getAccountDef, LedgerError }
