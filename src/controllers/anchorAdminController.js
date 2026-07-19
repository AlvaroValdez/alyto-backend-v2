/**
 * anchorAdminController.js — AnchorAdmin, Fase 1 (HTTP, solo lectura)
 *
 * Controladores delgados: HTTP req/res. Toda la lógica vive en anchorAdminService.
 * Prefijo: /api/v1/admin/anchor (protect + checkAdmin + feature flag).
 */

import {
  getListenerStatus,
  getTreasuryStatus,
  reconcileDualLedger,
  getSolvencySnapshot,
} from '../services/anchorAdminService.js'
import { listAuditLogs } from '../services/adminAuditService.js'
import { logger } from '../utils/logger.js'

/** GET /api/v1/admin/anchor/listener — 4.2 estado del listener de Horizon */
export async function handleListenerStatus(req, res) {
  try {
    return res.status(200).json(await getListenerStatus())
  } catch (err) {
    logger.error('[anchorAdmin] listener status error', { err: err.message })
    return res.status(500).json({ error: 'No se pudo obtener el estado del listener.' })
  }
}

/** GET /api/v1/admin/anchor/treasury — 4.3 tesorería on-chain */
export async function handleTreasuryStatus(req, res) {
  try {
    return res.status(200).json(await getTreasuryStatus())
  } catch (err) {
    logger.error('[anchorAdmin] treasury status error', { err: err.message })
    return res.status(500).json({ error: 'No se pudo obtener el estado de tesorería.' })
  }
}

/** GET /api/v1/admin/anchor/reconciliation — 4.4 reconciliación dual ledger */
export async function handleReconciliation(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '500', 10) || 500, 2000)
    return res.status(200).json(await reconcileDualLedger({ limit }))
  } catch (err) {
    logger.error('[anchorAdmin] reconciliation error', { err: err.message })
    return res.status(500).json({ error: 'No se pudo ejecutar la reconciliación.' })
  }
}

/** GET /api/v1/admin/anchor/solvency — 4.5 cuadre de reservas contra pasivos */
export async function handleSolvency(req, res) {
  try {
    return res.status(200).json(await getSolvencySnapshot())
  } catch (err) {
    logger.error('[anchorAdmin] solvency error', { err: err.message })
    return res.status(500).json({ error: 'No se pudo calcular la solvencia.' })
  }
}

/** GET /api/v1/admin/anchor/audit — registro de acciones sensibles del admin (el panel auditable) */
export async function handleAuditLog(req, res) {
  try {
    const { action, actorId, targetType, targetId, from, to, page, limit } = req.query
    const result = await listAuditLogs({ action, actorId, targetType, targetId, from, to, page, limit })
    return res.status(200).json(result)
  } catch (err) {
    logger.error('[anchorAdmin] audit log error', { err: err.message })
    return res.status(500).json({ error: 'No se pudo obtener el registro de auditoría.' })
  }
}
