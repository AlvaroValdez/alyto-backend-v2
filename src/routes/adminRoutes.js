/**
 * adminRoutes.js — Rutas del Panel de Administración
 *
 * Todas las rutas requieren:
 *   1. protect()    → JWT válido, carga req.user
 *   2. checkAdmin() → req.user.role === 'admin', responde 403 si no
 *
 * Montado en server.js bajo: /api/v1/admin
 *
 * Endpoints:
 *   GET   /users                              — Lista todos los usuarios
 *   GET   /ledger                             — Últimas 100 operaciones (legacy)
 *   GET   /transactions                       — Ledger paginado con filtros y resumen
 *   GET   /transactions/:transactionId        — Detalle completo de una transacción
 *   PATCH /transactions/:transactionId/status — Actualización manual de status
 *   GET   /corridors                          — Lista todos los corredores
 *   PATCH /corridors/:corridorId              — Actualiza parámetros de un corredor
 */

import { Router }    from 'express';
import { protect }   from '../middlewares/authMiddleware.js';
import { checkAdmin } from '../middlewares/checkAdmin.js';
import {
  getAllUsers,
  getGlobalLedger,
  listTransactions,
  getTransaction,
  updateTransactionStatus,
  listCorridors,
  createCorridor,
  updateCorridor,
  deactivateCorridor,
  getCorridorAnalytics,
  getGlobalAnalytics,
} from '../controllers/adminController.js';

const router = Router();

// Aplicar protect + checkAdmin a TODAS las rutas de este router
router.use(protect, checkAdmin);

// ─── Usuarios ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/users
 * Lista todos los usuarios del sistema ordenados por fecha de creación.
 */
router.get('/users', getAllUsers);

// ─── Ledger legacy ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/ledger
 * Últimas 100 operaciones con usuario origen populado (vista rápida).
 * Para consultas filtradas y paginadas, usar /transactions.
 */
router.get('/ledger', getGlobalLedger);

// ─── Backoffice Ledger — Transacciones ────────────────────────────────────────

/**
 * GET /api/v1/admin/transactions
 *
 * Lista paginada de transacciones con filtros y resumen estadístico.
 *
 * Query params opcionales:
 *   status      — Ej: "completed", "failed", "in_transit"
 *   corridorId  — Slug del corredor (ej. "cl-bo-fintoc-anchorbolivia")
 *   entity      — "LLC" | "SpA" | "SRL"
 *   startDate   — ISO 8601 (ej. "2026-01-01")
 *   endDate     — ISO 8601 (ej. "2026-03-31")
 *   page        — default 1
 *   limit       — default 20, máximo 100
 *
 * Responde: { transactions, pagination, summary }
 */
router.get('/transactions', listTransactions);

/**
 * GET /api/v1/admin/transactions/:transactionId
 *
 * Documento completo de una transacción, incluyendo ipnLog y userId poblado.
 * Params: transactionId — alytoTransactionId (ej. "ALY-B-1710000000000-XYZ123")
 */
router.get('/transactions/:transactionId', getTransaction);

/**
 * PATCH /api/v1/admin/transactions/:transactionId/status
 *
 * Actualización manual del status. Registra la intervención en ipnLog.
 * Body: { status: String, note: String }
 */
router.patch('/transactions/:transactionId/status', updateTransactionStatus);

// ─── Corredores ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/corridors
 * Todos los corredores (activos e inactivos), ordenados por corridorId.
 */
router.get('/corridors', listCorridors);

/**
 * POST /api/v1/admin/corridors
 * Crea un corredor nuevo. Valida que corridorId no exista.
 * Body: todos los campos requeridos de TransactionConfig.
 */
router.post('/corridors', createCorridor);

/**
 * PATCH /api/v1/admin/corridors/:corridorId
 * Actualiza parámetros de un corredor con registro en changeLog.
 * corridorId es inmutable.
 */
router.patch('/corridors/:corridorId', updateCorridor);

/**
 * DELETE /api/v1/admin/corridors/:corridorId
 * Baja lógica: isActive: false + deletedAt. No elimina físicamente.
 */
router.delete('/corridors/:corridorId', deactivateCorridor);

/**
 * GET /api/v1/admin/corridors/:corridorId/analytics
 * Rentabilidad del corredor en el periodo indicado.
 * Query params: startDate, endDate (ISO)
 */
router.get('/corridors/:corridorId/analytics', getCorridorAnalytics);

// ─── Analytics Global ─────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/analytics
 * Analytics global: volumen, revenue, desglose por entidad y corredor.
 * Query params: startDate, endDate (ISO)
 */
router.get('/analytics', getGlobalAnalytics);

export default router;
