/**
 * anchorAdminRoutes.js — AnchorAdmin, Fase 1 (solo lectura)
 *
 * Panel de administración interna del Stellar Anchor de Alyto. Acceso restringido:
 *   protect() → JWT válido | checkAdmin() → role admin
 *
 * Montado en server.js SOLO si ANCHOR_ADMIN_ENABLED=true (feature gating para
 * rollback inmediato, patrón del proyecto). Prefijo: /api/v1/admin/anchor
 *
 * Endpoints (Fase 1, todos GET / solo lectura):
 *   GET /listener        — 4.2 estado del listener de Horizon (polling + heartbeat)
 *   GET /treasury        — 4.3 tesorería on-chain (SRL + channel account)
 *   GET /reconciliation  — 4.4 reconciliación dual ledger (mongo vs Stellar)
 *   GET /solvency        — 4.5 reservas vs pasivos (prueba de solvencia)
 *   GET /audit           — registro de acciones sensibles del admin (panel auditable, §5)
 */

import { Router }     from 'express'
import { protect }    from '../middlewares/authMiddleware.js'
import { checkAdmin } from '../middlewares/checkAdmin.js'
import {
  handleListenerStatus,
  handleTreasuryStatus,
  handleReconciliation,
  handleSolvency,
  handleFrozenWallets,
  handleAuditLog,
} from '../controllers/anchorAdminController.js'

const router = Router()

// Todas las rutas exigen admin autenticado.
router.use(protect, checkAdmin)

router.get('/listener',       handleListenerStatus)
router.get('/treasury',       handleTreasuryStatus)
router.get('/reconciliation', handleReconciliation)
router.get('/solvency',       handleSolvency)
router.get('/frozen',         handleFrozenWallets)
router.get('/audit',          handleAuditLog)

export default router
