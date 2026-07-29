/**
 * ledgerClose.js — GL autoritativo: storno (reversos) y cierre de período (Fase 4)
 *
 * Reglas contables que hacen el libro mayor autoritativo:
 *   - Los asientos NUNCA se editan ni se borran. Un error se corrige con un
 *     asiento de REVERSA (storno) que apunta a reversalOf. (reverseEntry)
 *   - Un período CERRADO se bloquea: no se admiten asientos con fecha ≤ el corte
 *     (excepto los propios de cierre/apertura). Al cerrar, el resultado del período
 *     (ingreso − gasto) se traslada a 3090 Resultados acumulados. (closePeriod)
 *
 * NO cubre (decisiones abiertas §12.2/.3, requieren contador):
 *   - Revaluación FX de la cuenta 1090 al cierre (§12.2).
 *   - Consolidación en una moneda funcional única (§12.3).
 * El cierre aquí es POR MONEDA (cada moneda cierra su resultado a 3090).
 */

import JournalEntry from '../models/JournalEntry.js'
import JournalLine  from '../models/JournalLine.js'
import SystemConfig from '../models/SystemConfig.js'
import { postEntry, LedgerError } from './ledgerService.js'
import { aggregateByAccount } from './ledgerReports.js'
import { getAccountDef } from './ledgerService.js'
import { logger } from './../utils/logger.js'

const CLOSED_KEY = 'ledger:period:closedThrough'
const RETAINED   = '3090'   // Resultados acumulados (patrimonio, multi-moneda)
const R7 = (n) => +(Number(n) || 0).toFixed(7)

// ═══════════════════════════════════════════════════════════════════════════
// PURAS
// ═══════════════════════════════════════════════════════════════════════════

/** Invierte débito↔crédito de cada línea (base del storno). Conserva cuenta/moneda/dims. */
export function buildReversalLines(lines) {
  return lines.map(l => ({
    account: l.account,
    currency: l.currency,
    debit:  R7(l.credit),
    credit: R7(l.debit),
    dims: l.dims ?? {},
  }))
}

/**
 * Construye las líneas del asiento de cierre para UNA moneda: salda ingresos (4xxx)
 * y gastos (5xxx) contra 3090, cuyo neto = resultado del período.
 * @param {Array<{account,type,balance}>} rows  cuentas 4xxx/5xxx con su saldo (mismo signo del lado normal)
 * @param {string} currency
 * @returns {Array|null} líneas balanceadas, o null si no hay nada que cerrar
 */
export function buildClosingLines(rows, currency) {
  const lines = []
  let net = 0   // ingreso − gasto
  for (const r of rows) {
    const bal = R7(r.balance)
    if (bal === 0) continue
    if (r.type === 'income') {        // saldo acreedor → se debita para saldar
      lines.push({ account: r.account, currency, debit: bal, credit: 0, dims: { sourceTxId: 'CLOSE' } })
      net += bal
    } else if (r.type === 'expense') {// saldo deudor → se acredita para saldar
      lines.push({ account: r.account, currency, debit: 0, credit: bal, dims: { sourceTxId: 'CLOSE' } })
      net -= bal
    }
  }
  if (!lines.length) return null
  const netR = R7(net)
  // Resultado → 3090. Utilidad (net>0) = crédito a patrimonio; pérdida = débito.
  if (netR > 0)      lines.push({ account: RETAINED, currency, debit: 0, credit: netR, dims: { sourceTxId: 'CLOSE' } })
  else if (netR < 0) lines.push({ account: RETAINED, currency, debit: -netR, credit: 0, dims: { sourceTxId: 'CLOSE' } })
  return lines
}

// ═══════════════════════════════════════════════════════════════════════════
// CON DB
// ═══════════════════════════════════════════════════════════════════════════

/** Fecha hasta la cual el período está cerrado (o null). */
export async function getClosedThrough() {
  const v = await SystemConfig.getValue(CLOSED_KEY, null)
  return v?.at ? new Date(v.at) : null
}

/**
 * Guard de retro-posteo: rechaza asientos con fecha ≤ el corte de cierre, salvo los
 * de cierre/apertura. Se invoca desde postEntry.
 * @throws {LedgerError}
 */
export async function assertNotInClosedPeriod({ date, posturePurpose }) {
  const purpose = posturePurpose ?? 'default'
  if (purpose.startsWith('close') || purpose === 'opening') return true
  const closed = await getClosedThrough()
  if (closed && new Date(date ?? Date.now()) <= closed) {
    throw new LedgerError(`período cerrado hasta ${closed.toISOString().slice(0, 10)}: no se admite posteo con fecha ≤ ese corte`)
  }
  return true
}

/**
 * Reversa (storno) de un asiento. Idempotente: si ya existe su reversa, la devuelve.
 * Marca el original como 'reversed'. Corre en su propia transacción o en la recibida.
 * @param {{entryId:string, reason:string, postedBy?:string}} p
 */
export async function reverseEntry({ entryId, reason, postedBy = 'system' }, session) {
  const original = await JournalEntry.findOne({ entryId }).session(session ?? null)
  if (!original) throw new LedgerError(`asiento no encontrado: ${entryId}`)
  if (original.reversalOf) throw new LedgerError(`no se reversa un asiento que ya es una reversa (${entryId})`)

  // Idempotencia: ¿ya existe una reversa de este asiento?
  const existing = await JournalEntry.findOne({ reversalOf: entryId }).session(session ?? null)
  if (existing) return existing

  const lines = await JournalLine.find({ entryId }).session(session ?? null).lean()
  if (!lines.length) throw new LedgerError(`asiento sin líneas: ${entryId}`)

  const reversal = await postEntry({
    entity: original.entity,
    sourceType: 'manual',
    sourceRef: `REV-${entryId}`,
    posturePurpose: 'reversal',
    description: `Storno de ${entryId}${reason ? ` — ${reason}` : ''}`,
    postedBy,
    reversalOf: entryId,
    date: new Date(),
    lines: buildReversalLines(lines),
  }, session)

  await JournalEntry.updateOne({ entryId }, { $set: { status: 'reversed' } }, { session: session ?? undefined })
  logger.info?.('[ledger-close] storno', { original: entryId, reversal: reversal.entryId })
  return reversal
}

/**
 * Cierra el período hasta `asOf`: saldo de ingresos/gastos (por moneda) → 3090, y
 * fija el corte de cierre (bloquea retro-posteo). Idempotente por asOf.
 * @param {{asOf:string|Date, postedBy?:string, dryRun?:boolean}} p
 */
export async function closePeriod({ asOf, postedBy = 'system', dryRun = false } = {}) {
  const asOfDate = new Date(asOf ?? Date.now())
  if (isNaN(asOfDate)) throw new LedgerError('asOf inválido')

  const prevClose = await getClosedThrough()
  if (prevClose && asOfDate <= prevClose) {
    throw new LedgerError(`el período ya está cerrado hasta ${prevClose.toISOString().slice(0, 10)}`)
  }

  // Ingresos/gastos con fecha ≤ asOf (aún no cerrados: prior close ya los saldó a 0).
  const entries = await JournalEntry.find({ date: { $lte: asOfDate } }).select('entryId').lean()
  const ids = entries.map(e => e.entryId)
  const lines = await JournalLine.find({ entryId: { $in: ids }, account: { $regex: /^[45]/ } })
    .select('account currency debit credit').lean()
  const rows = aggregateByAccount(lines).map(r => ({ ...r, type: getAccountDef(r.account)?.type }))

  // Agrupar por moneda y construir un asiento de cierre por moneda.
  const byCur = {}
  for (const r of rows) (byCur[r.currency] ??= []).push(r)

  const posted = []
  for (const [currency, curRows] of Object.entries(byCur)) {
    const closeLines = buildClosingLines(curRows, currency)
    if (!closeLines) continue
    const period = asOfDate.toISOString().slice(0, 10)
    if (dryRun) { posted.push({ currency, lines: closeLines, entryId: null }); continue }
    const entry = await postEntry({
      entity: 'SRL',
      sourceType: 'manual',
      sourceRef: `CLOSE-${period}-${currency}`,
      posturePurpose: `close-${period}`,
      description: `Cierre de período al ${period} (${currency})`,
      postedBy,
      date: asOfDate,
      lines: closeLines,
    })
    posted.push({ currency, entryId: entry.entryId })
  }

  if (!dryRun) await SystemConfig.setValue(CLOSED_KEY, { at: asOfDate.toISOString() })
  logger.info?.('[ledger-close] cierre de período', { asOf: asOfDate.toISOString(), monedas: posted.length, dryRun })
  return { asOf: asOfDate.toISOString(), closedThrough: dryRun ? (prevClose?.toISOString() ?? null) : asOfDate.toISOString(), entries: posted, dryRun }
}

export default { buildReversalLines, buildClosingLines, reverseEntry, closePeriod, getClosedThrough, assertNotInClosedPeriod }
