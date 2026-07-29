/**
 * ledgerAdminController.js — Reportes del Libro Mayor para el panel admin (Fase 3)
 *
 * Controladores delgados (HTTP req/res). Toda la lógica vive en ledgerReports /
 * ledgerStatements / ledgerSync. Prefijo: /api/v1/admin/ledger
 * (protect + checkAdmin + feature flag LEDGER_POSTING_ENABLED en las rutas).
 */

import { trialBalance, reconcileControlAccounts } from '../services/ledgerReports.js'
import { balanceSheet, incomeStatement, treasuryStatement } from '../services/ledgerStatements.js'
import { syncLedgerFromWalletTx, ledgerPostingEnabled } from '../services/ledgerSync.js'
import { reverseEntry, closePeriod, getClosedThrough } from '../services/ledgerClose.js'
import { LedgerError } from '../services/ledgerService.js'
import { logger } from '../utils/logger.js'

const fail = (res, err, msg) => {
  logger.error?.('[ledgerAdmin] error', { err: err.message })
  return res.status(500).json({ error: msg })
}

/** GET /admin/ledger/trial-balance — balance de comprobación (Σdébito=Σcrédito por moneda). */
export async function handleTrialBalance(req, res) {
  try { return res.status(200).json(await trialBalance({ entity: req.query.entity })) }
  catch (e) { return fail(res, e, 'No se pudo generar el balance de comprobación.') }
}

/** GET /admin/ledger/reconciliation — GL vs saldos de wallets vs on-chain. */
export async function handleReconciliation(req, res) {
  try { return res.status(200).json(await reconcileControlAccounts({ entity: req.query.entity })) }
  catch (e) { return fail(res, e, 'No se pudo reconciliar el libro mayor.') }
}

/** GET /admin/ledger/balance-sheet — balance general (activo = pasivo + patrimonio + resultado). */
export async function handleBalanceSheet(req, res) {
  try { return res.status(200).json(await balanceSheet({ entity: req.query.entity })) }
  catch (e) { return fail(res, e, 'No se pudo generar el balance general.') }
}

/** GET /admin/ledger/pnl?from&to — estado de resultados por período. */
export async function handleIncomeStatement(req, res) {
  try { return res.status(200).json(await incomeStatement({ from: req.query.from, to: req.query.to, entity: req.query.entity })) }
  catch (e) { return fail(res, e, 'No se pudo generar el estado de resultados.') }
}

/** GET /admin/ledger/treasury/:account?from&to — estado de cuenta con saldo corriente. */
export async function handleTreasuryStatement(req, res) {
  try {
    return res.status(200).json(await treasuryStatement({
      account: req.params.account, from: req.query.from, to: req.query.to, entity: req.query.entity,
    }))
  } catch (e) {
    if (/desconocida/.test(e.message)) return res.status(400).json({ error: e.message })
    return fail(res, e, 'No se pudo generar el estado de cuenta.')
  }
}

/** POST /admin/ledger/sync — dispara la proyección forward bajo demanda (respeta el flag). */
export async function handleSyncNow(req, res) {
  try {
    if (!ledgerPostingEnabled()) return res.status(200).json({ skipped: 'flag-off', message: 'LEDGER_POSTING_ENABLED apagado.' })
    return res.status(200).json(await syncLedgerFromWalletTx({ dryRun: false }))
  } catch (e) { return fail(res, e, 'No se pudo ejecutar la sincronización.') }
}

/** GET /admin/ledger/closed-through — fecha hasta la que el período está cerrado. */
export async function handleClosedThrough(req, res) {
  try {
    const closed = await getClosedThrough()
    return res.status(200).json({ closedThrough: closed ? closed.toISOString() : null })
  } catch (e) { return fail(res, e, 'No se pudo obtener el corte de cierre.') }
}

/** POST /admin/ledger/close — cierra el período hasta `asOf` (body { asOf, dryRun }). */
export async function handleClosePeriod(req, res) {
  try {
    const { asOf, dryRun } = req.body ?? {}
    const postedBy = req.user?._id ? String(req.user._id) : 'system'
    return res.status(200).json(await closePeriod({ asOf, dryRun: !!dryRun, postedBy }))
  } catch (e) {
    if (e instanceof LedgerError) return res.status(400).json({ error: e.message })
    return fail(res, e, 'No se pudo cerrar el período.')
  }
}

/** POST /admin/ledger/entries/:entryId/reverse — storno de un asiento (body { reason }). */
export async function handleReverseEntry(req, res) {
  try {
    const postedBy = req.user?._id ? String(req.user._id) : 'system'
    const reversal = await reverseEntry({ entryId: req.params.entryId, reason: req.body?.reason, postedBy })
    return res.status(200).json({ reversal: { entryId: reversal.entryId, reversalOf: reversal.reversalOf } })
  } catch (e) {
    if (e instanceof LedgerError) return res.status(400).json({ error: e.message })
    return fail(res, e, 'No se pudo reversar el asiento.')
  }
}
