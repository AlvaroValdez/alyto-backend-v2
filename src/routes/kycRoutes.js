/**
 * kycRoutes.js — Rutas de Verificación KYC
 *
 * Prefijo registrado en server.js: /api/v1/kyc
 *
 * Endpoints:
 *   GET  /api/v1/kyc/session         → Crea VerificationSession de Stripe Identity
 *   GET  /api/v1/kyc/status          → Estado KYC del usuario autenticado
 *   POST /api/v1/kyc/session/restart → Cancela la sesión en curso y habilita el reintento
 *   POST /api/v1/kyc/telemetry       → Hitos del intento reportados por el cliente
 */

import { Router }                                    from 'express';
import {
  createKycSession,
  getKycStatus,
  restartKycSession,
  recordKycClientEvent,
  getKycDebug,
  approveKycTest,
} from '../controllers/kycController.js';
import { protect, requireAdmin, requireEmailVerified } from '../middlewares/authMiddleware.js';
import { kycSessionLimiter }                          from '../config/rateLimiters.js';

const router = Router();

/**
 * Gate: la información de cumplimiento (CDD) debe estar completa antes de lanzar
 * la biometría. Garantiza el orden del onboarding del lado del servidor:
 *   verify-email → PATCH /user/kyc-profile → GET /kyc/session (Stripe Identity).
 */
function requireKycProfile(req, res, next) {
  if (!req.user?.kycProfileCompletedAt) {
    return res.status(403).json({
      success: false,
      message: 'Completa tu información de cumplimiento antes de la verificación biométrica.',
      code:    'KYC_PROFILE_REQUIRED',
    });
  }
  next();
}

/**
 * GET /api/v1/kyc/session
 * Crea una sesión biométrica de Stripe Identity.
 * Requiere JWT válido + email verificado + info de cumplimiento completa.
 * Rate-limited: cada llamada crea una sesión en Stripe (costo).
 */
router.get('/session', protect, requireEmailVerified, requireKycProfile, kycSessionLimiter, createKycSession);

/**
 * GET /api/v1/kyc/status
 * Devuelve el kycStatus actual del usuario.
 * El frontend hace polling a este endpoint post-verificación.
 * Requiere JWT válido.
 */
router.get('/status', protect, getKycStatus);

/**
 * POST /api/v1/kyc/session/restart
 * Cancela la sesión de Stripe en curso y devuelve al usuario a 'pending'.
 * Mismos gates que /session: quien no puede crear una sesión tampoco reinicia.
 * Comparte el limiter porque reiniciar siempre precede a crear otra sesión
 * (con 10/h, deja unos 5 reintentos por hora).
 */
router.post('/session/restart', protect, requireEmailVerified, requireKycProfile, kycSessionLimiter, restartKycSession);

/**
 * POST /api/v1/kyc/telemetry
 * Hito del intento que solo el cliente puede observar (volver del alojado de
 * Stripe). Sin efectos sobre el estado KYC: solo anota. Requiere JWT válido.
 */
router.post('/telemetry', protect, recordKycClientEvent);

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
