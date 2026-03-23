/**
 * payoutRoutes.js — Rutas de Off-Ramp y Liquidación
 *
 * Prefijo registrado en server.js: /api/v1/payouts
 *
 * Endpoints disponibles:
 *   POST /api/v1/payouts/bolivia/manual  — Liquidación manual Corredor Bolivia (SRL)
 *
 * NOTA DE SEGURIDAD: En producción estos endpoints deben estar protegidos por
 * autenticación JWT y verificación de rol de operador (RBAC). El middleware de
 * autenticación se añadirá en la Fase de Seguridad.
 */

import { Router }                    from 'express';
import { processBoliviaManualPayout } from '../controllers/payoutController.js';
import { protect, requireEntity }    from '../middlewares/authMiddleware.js';

const router = Router();

/**
 * POST /api/v1/payouts/bolivia/manual
 *
 * Ejecuta la liquidación manual del Corredor Bolivia para transacciones
 * que ya completaron el tránsito en Stellar (status: 'in_transit').
 * Solo disponible para operaciones bajo AV Finance SRL (legalEntity: 'SRL').
 *
 * Body: { transactionId, tipoCambioManual? }
 * Respuesta: PDF binary (application/pdf) — Comprobante Oficial de Transacción
 */
// Requiere JWT válido + usuario bajo AV Finance SRL (Bolivia)
router.post('/bolivia/manual', protect, requireEntity(['SRL']), processBoliviaManualPayout);

export default router;
