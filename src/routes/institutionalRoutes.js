/**
 * institutionalRoutes.js — Rutas del Corredor Institucional (AV Finance LLC)
 *
 * Prefijo registrado en server.js: /api/v1/institutional
 *
 * Endpoints disponibles:
 *   POST /api/v1/institutional/onramp/owlpay      — On-ramp B2B vía OwlPay (LLC)
 *
 * NOTA DE SEGURIDAD: En producción, /onramp/owlpay debe estar protegido por
 * autenticación JWT con verificación de rol corporativo (RBAC).
 *
 * El webhook OwlPay/Harbor vive en /api/v1/ipn/owlpay (handleOwlPayIPN).
 */

import { Router }                                from 'express';
import { initiateCorporateOnRamp }                from '../controllers/institutionalController.js';
import { protect, requireEntity }                from '../middlewares/authMiddleware.js';

const router = Router();

// ─── Rutas ────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/institutional/onramp/owlpay
 *
 * Inicia un on-ramp institucional fiat → USDC para clientes LLC.
 * Requiere: { userId, amount (USD), destinationWallet (Stellar public key) }
 * Devuelve: { owlPayOrderId, paymentUrl, estimatedUSDC, alytoTransactionId }
 */
// Requiere JWT válido + usuario bajo AV Finance LLC (clientes corporativos / EE.UU.)
router.post('/onramp/owlpay', protect, requireEntity(['LLC']), initiateCorporateOnRamp);

export default router;
