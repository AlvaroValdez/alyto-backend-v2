/**
 * payoutRoutes.js — Rutas de Off-Ramp y Liquidación
 *
 * Prefijo registrado en server.js: /api/v1/payouts
 *
 * Endpoints disponibles:
 *   POST /api/v1/payouts/bolivia/manual  — Liquidación manual Corredor Bolivia (SRL)
 *
 * CONTROL DE ACCESO (cerrado 2026-08-15): este endpoint marca la transacción como
 * 'completed', consume un correlativo oficial BOL-YYYYMM-NNNNNN y emite el
 * Comprobante Oficial de Transacción — un documento con valor regulatorio ante ASFI.
 * Es una operación de back-office, NO del titular de la transacción: exige
 * `protect` + `requireAdmin`.
 *
 * ⚠️ NO usar `requireEntity(['SRL'])` aquí: ese middleware valida la entidad legal
 * del LLAMADOR, y los administradores se crean bajo LLC (ver scripts/seedAdmin.js).
 * La restricción de jurisdicción que importa es sobre la TRANSACCIÓN
 * (`transaction.legalEntity === 'SRL'`) y la aplica el controlador.
 */

import { Router }                    from 'express';
import { processBoliviaManualPayout } from '../controllers/payoutController.js';
import { protect, requireAdmin }     from '../middlewares/authMiddleware.js';

const router = Router();

/**
 * POST /api/v1/payouts/bolivia/manual
 *
 * Ejecuta la liquidación manual del Corredor Bolivia para transacciones
 * que ya completaron el tránsito en Stellar (status: 'in_transit').
 * Solo aplica a transacciones bajo AV Finance SRL (transaction.legalEntity: 'SRL').
 *
 * Body: { transactionId, tipoCambioManual? }
 *   tipoCambioManual — override acotado (±PAYOUT_MANUAL_RATE_MAX_DEVIATION_PCT
 *   sobre la tasa bloqueada en la cotización). Se audita en AdminAuditLog.
 *
 * Respuesta: PDF binary (application/pdf) — Comprobante Oficial de Transacción
 */
// Requiere JWT válido + rol admin. El controlador revalida el rol (defensa en
// profundidad) y exige que la TRANSACCIÓN sea SRL.
router.post('/bolivia/manual', protect, requireAdmin, processBoliviaManualPayout);

export default router;
