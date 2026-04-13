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
import { protect, requireAdmin }                      from '../middlewares/authMiddleware.js';

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

// ─── Endpoints de desarrollo (opt-in vía ALYTO_ENABLE_DEV_ROUTES=1) ─────────
// SECURITY: Never set ALYTO_ENABLE_DEV_ROUTES=1 in production environment.
if (process.env.ALYTO_ENABLE_DEV_ROUTES === '1') {
  /**
   * POST /api/v1/kyc/approve-test
   * Aprueba KYC sin pasar por Stripe — para testing de flujos post-KYC.
   * Body: { userId: string }
   * Requiere JWT de admin.
   */
  router.post('/approve-test', protect, requireAdmin, approveKycTest);

  /**
   * GET /api/v1/kyc/debug/:userId
   * Solo diagnóstico local — requiere JWT de admin.
   */
  router.get('/debug/:userId', protect, requireAdmin, getKycDebug);
}

export default router;
