/**
 * ledgerAdminRoutes.js — Reportes del Libro Mayor (Fase 3, feature-gated)
 *
 * Montado en server.js SOLO si LEDGER_POSTING_ENABLED está activo. Acceso admin.
 * Prefijo: /api/v1/admin/ledger
 *
 * Todos read-only salvo POST /sync (dispara la proyección, respeta el flag).
 */

import { Router }     from 'express'
import { protect }    from '../middlewares/authMiddleware.js'
import { checkAdmin } from '../middlewares/checkAdmin.js'
import {
  handleTrialBalance,
  handleReconciliation,
  handleBalanceSheet,
  handleIncomeStatement,
  handleTreasuryStatement,
  handleSyncNow,
} from '../controllers/ledgerAdminController.js'

const router = Router()

router.use(protect, checkAdmin)

router.get('/trial-balance',       handleTrialBalance)
router.get('/reconciliation',      handleReconciliation)
router.get('/balance-sheet',       handleBalanceSheet)
router.get('/pnl',                 handleIncomeStatement)
router.get('/treasury/:account',   handleTreasuryStatement)
router.post('/sync',               handleSyncNow)

export default router
