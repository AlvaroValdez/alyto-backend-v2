/**
 * authRoutes.js — Rutas de Autenticación y Onboarding
 *
 * Prefijo registrado en server.js: /api/v1/auth
 *
 * Rate limiting aplicado por ruta (solo en producción):
 *   POST /login           → loginLimiter          (5 intentos / 15 min / IP)
 *   POST /register        → registerLimiter        (5 intentos / hora / IP)
 *   POST /forgot-password → forgotPasswordLimiter  (3 intentos / hora / IP)
 *   POST /reset-password  → resetPasswordLimiter   (5 intentos / hora / IP)
 *   GET  /me              → sin limiter propio (solo general limiter del servidor)
 *   POST /fcm-token       → sin limiter propio (requiere JWT válido)
 */

import { Router } from 'express';
import {
  registerUser,
  loginUser,
  logoutUser,
  getMe,
  forgotPassword,
  resetPassword,
  registerFcmToken,
  verifyEmail,
  resendVerification,
  deleteAccount,
} from '../controllers/authController.js';
import { protect } from '../middlewares/authMiddleware.js';
import {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  emailVerifyLimiter,
} from '../config/rateLimiters.js';

const router = Router();

/**
 * POST /api/v1/auth/login
 * Body: { email, password, rememberMe? }
 */
router.post('/login', loginLimiter, loginUser);

/**
 * POST /api/v1/auth/register
 * Body: { email, password, country, firstName?, lastName?, phone? }
 */
router.post('/register', registerLimiter, registerUser);

/**
 * GET /api/v1/auth/me
 * Valida el token activo y devuelve el perfil fresco del usuario.
 * Sin rate limiter propio — es un endpoint de lectura autenticado, no un
 * vector de brute-force. Solo aplica el generalLimiter del servidor.
 */
router.get('/me', protect, getMe);

/**
 * POST /api/v1/auth/verify-email   (protegido)
 * Confirma el email del usuario con el código de 6 dígitos.
 * Body: { code }
 */
router.post('/verify-email', protect, emailVerifyLimiter, verifyEmail);

/**
 * POST /api/v1/auth/resend-verification   (protegido)
 * Reenvía el código de verificación (cooldown 60s por usuario).
 */
router.post('/resend-verification', protect, emailVerifyLimiter, resendVerification);

/**
 * POST /api/v1/auth/forgot-password
 * Genera token de reset y envía email (siempre 200 — no revela si existe el email).
 * Body: { email }
 */
router.post('/forgot-password', forgotPasswordLimiter, forgotPassword);

/**
 * POST /api/v1/auth/reset-password
 * Valida token y actualiza la contraseña.
 * Body: { token, newPassword }
 */
router.post('/reset-password', resetPasswordLimiter, resetPassword);

/**
 * POST /api/v1/auth/logout
 * Revoca todos los tokens activos (incrementa tokenVersion) y limpia la cookie.
 */
router.post('/logout', protect, logoutUser);

/**
 * POST /api/v1/auth/fcm-token
 * Registra un token FCM para notificaciones push.
 * Sin rate limiter propio — requiere JWT válido (protect ya lo garantiza).
 * Body: { token: string }
 */
router.post('/fcm-token', protect, registerFcmToken);

/**
 * DELETE /api/v1/auth/account
 * Eliminación de cuenta solicitada por el usuario (requisito Google Play + GDPR).
 * Re-autentica con contraseña, bloquea si hay saldo u operaciones en curso,
 * desactiva la cuenta y anonimiza PII no regulatoria (KYC/tx retenidos por ley).
 * Body: { password, confirm: true }
 */
router.delete('/account', protect, deleteAccount);

export default router;
