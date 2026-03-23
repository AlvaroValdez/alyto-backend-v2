/**
 * kycRoutes.js — Rutas de Verificación KYC
 *
 * Prefijo registrado en server.js: /api/v1/kyc
 *
 * Endpoints:
 *   GET /api/v1/kyc/session  → Crea VerificationSession de Stripe Identity
 *   GET /api/v1/kyc/status   → Estado KYC del usuario autenticado
 */

import { Router }                                    from 'express';
import { createKycSession, getKycStatus, getKycDebug, approveKycTest } from '../controllers/kycController.js';
import { protect }                                    from '../middlewares/authMiddleware.js';

const router = Router();

/**
 * GET /api/v1/kyc/session
 * Crea una sesión biométrica de Stripe Identity.
 * Requiere JWT válido.
 */
router.get('/session', protect, createKycSession);

/**
 * GET /api/v1/kyc/status
 * Devuelve el kycStatus actual del usuario.
 * El frontend hace polling a este endpoint post-verificación.
 * Requiere JWT válido.
 */
router.get('/status', protect, getKycStatus);

/**
 * POST /api/v1/kyc/approve-test
 * Solo activo en NODE_ENV !== 'production'.
 * Aprueba KYC sin pasar por Stripe — para testing de flujos post-KYC.
 * Body: { userId: string }
 */
router.post('/approve-test', approveKycTest);

/**
 * GET /api/v1/kyc/debug/:userId
 * Solo activo en NODE_ENV !== 'production'.
 * No requiere JWT — solo para diagnóstico local.
 */
router.get('/debug/:userId', getKycDebug);

export default router;
