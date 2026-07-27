/**
 * ledgerSync.js — Proyección forward del Libro Mayor desde WalletTransaction (Fase 2)
 *
 * Shadow mode: el GL se proyecta DESDE la capa subsidiaria (WalletTransaction), que
 * ya es atómica y completa. En vez de enganchar postEntry en cada controlador de
 * dinero (invasivo), un job idempotente y cursor-based lee los WalletTransaction
 * completados DESPUÉS del asiento de apertura y los postea. Cero cambios en los
 * flujos de dinero; el GL sigue reconciliando conforme entran movimientos.
 *
 * Idempotente por (sourceType='wallet_tx', sourceRef=wtxId, purpose) → correr N
 * veces no duplica. El cursor (SystemConfig) evita reprocesar todo cada corrida.
 *
 * Gate: LEDGER_POSTING_ENABLED ∈ {shadow, strict, true, 1}. El script manual puede
 * forzar con dryRun/commit; el job programado respeta el flag.
 *
 * NO cubre conversiones (slice B, decisión FX pendiente) — ledgerPostings las salta.
 */

import WalletTransaction from '../models/WalletTransaction.js'
import JournalEntry      from '../models/JournalEntry.js'
import SystemConfig      from '../models/SystemConfig.js'
import { postEntry }     from './ledgerService.js'
import { buildWalletTxEntry, classifyWalletTx } from './ledgerPostings.js'
import { logger }        from '../utils/logger.js'

const CURSOR_KEY = 'ledger:sync:cursor'

/** ¿Está habilitado el posteo del GL? */
export function ledgerPostingEnabled() {
  return ['shadow', 'strict', 'true', '1'].includes((process.env.LEDGER_POSTING_ENABLED ?? '').toLowerCase())
}

/** Fecha de corte = fecha del asiento de apertura. Los wtx posteriores se proyectan. */
async function getCutover() {
  const opening = await JournalEntry.findOne({ sourceType: 'manual', posturePurpose: 'opening' }).sort({ date: 1 }).lean()
  return opening?.date ?? null
}

/**
 * Proyecta al GL los WalletTransaction completados desde el corte / último cursor.
 * @param {{dryRun?:boolean, limit?:number}} opts
 * @returns {Promise<object>} resumen (scanned/posted/skipped/unmapped/cursor)
 */
export async function syncLedgerFromWalletTx({ dryRun = false, limit = 1000 } = {}) {
  const cutover = await getCutover()
  if (!cutover) {
    return { error: 'sin_apertura', message: 'No hay asiento de apertura. Corre npm run ledger:opening -- --commit primero.' }
  }

  const cursorVal = await SystemConfig.getValue(CURSOR_KEY, null)
  const since0    = cursorVal?.at ? new Date(cursorVal.at) : cutover
  const since     = since0 > cutover ? since0 : cutover   // nunca antes del corte (evita doble conteo)

  const wtxs = await WalletTransaction.find({ status: 'completed', updatedAt: { $gt: since } })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .lean()

  let posted = 0, skipped = 0
  const unmapped = []
  let lastAt = since

  for (const w of wtxs) {
    lastAt = w.updatedAt ?? lastAt
    const entry = buildWalletTxEntry(w)
    if (!entry) {
      skipped++
      const c = classifyWalletTx(w)
      if (/no mapeado/.test(c.reason ?? '')) unmapped.push({ wtxId: w.wtxId, type: w.type, reason: c.reason })
      continue
    }
    if (!dryRun) await postEntry(entry)   // standalone tx — proyección post-hoc (shadow)
    posted++
  }

  if (!dryRun && wtxs.length) {
    await SystemConfig.setValue(CURSOR_KEY, { at: new Date(lastAt).toISOString() })
  }

  const summary = {
    cutover: cutover.toISOString(),
    since:   since.toISOString(),
    scanned: wtxs.length,
    posted, skipped,
    unmappedCount: unmapped.length,
    unmapped: unmapped.slice(0, 20),
    cursorAdvancedTo: (!dryRun && wtxs.length) ? new Date(lastAt).toISOString() : null,
    dryRun,
  }
  logger.info?.('[ledger-sync] proyección', { scanned: summary.scanned, posted, skipped, unmapped: unmapped.length, dryRun })
  return summary
}

/** Runner del job programado: respeta el flag; no-op si está apagado. */
export async function runLedgerSyncJob() {
  if (!ledgerPostingEnabled()) return { skipped: 'flag-off' }
  try {
    return await syncLedgerFromWalletTx({ dryRun: false })
  } catch (err) {
    logger.error?.('[ledger-sync] error en job', { err: err.message })
    return { error: err.message }
  }
}

export default { syncLedgerFromWalletTx, runLedgerSyncJob, ledgerPostingEnabled }
