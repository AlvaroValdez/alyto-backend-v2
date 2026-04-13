/**
 * rateLimiters.js — Configuración centralizada de Rate Limiting por entorno
 *
 * Estrategia:
 *   - test                → sin límites (para pruebas automatizadas)
 *   - development/staging → límites activos, bypass opcional vía header
 *                            x-bypass-rate-limit === DEV_RATE_LIMIT_BYPASS_KEY
 *   - production          → límites estrictos, sin bypass posible
 *
 * Principio de menor privilegio:
 *   Solo los endpoints de mutación con riesgo de brute-force tienen limiters propios.
 *   Endpoints de lectura autenticada (GET /auth/me) quedan bajo el general limiter únicamente.
 *
 * Limiters disponibles:
 *   loginLimiter         → POST /auth/login        (5 intentos / 15 min por IP)
 *   registerLimiter      → POST /auth/register     (5 intentos / hora por IP)
 *   forgotPasswordLimiter → POST /auth/forgot-password (3 intentos / hora por IP)
 *   resetPasswordLimiter → POST /auth/reset-password  (5 intentos / hora por IP)
 *   generalLimiter       → todas las rutas         (200 req / 15 min por IP)
 *   paymentsLimiter      → /api/v1/payments/*      (20 req / min por IP)
 */

import rateLimit from 'express-rate-limit';

const ENV     = process.env.NODE_ENV ?? 'development';
const IS_PROD = ENV === 'production';
const IS_TEST = ENV === 'test';

// ─── Skip handler ─────────────────────────────────────────────────────────────
// En test se omite completamente para no bloquear suites automatizadas.
// En dev/staging se permite un bypass explícito vía header con clave secreta
// (para pruebas manuales sin deshabilitar la protección por defecto).
// En producción siempre aplica — no hay bypass posible.

function skip(req) {
  if (IS_TEST) return true;
  if (
    !IS_PROD &&
    process.env.DEV_RATE_LIMIT_BYPASS_KEY &&
    req.headers['x-bypass-rate-limit'] === process.env.DEV_RATE_LIMIT_BYPASS_KEY
  ) {
    return true;
  }
  return false;
}

// ─── Factory helper ───────────────────────────────────────────────────────────

function makeLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    skip,
    standardHeaders: true,   // RateLimit-* headers (RFC 6585)
    legacyHeaders:   false,  // Deshabilita X-RateLimit-* deprecados
    message:         { error: message },
    // Identifica al cliente por IP — en producción detrás de un proxy confiable
    // se puede cambiar a keyGenerator que use req.ip (ya manejado por express-rate-limit
    // cuando app.set('trust proxy', 1) está configurado).
  });
}

// ─── Limiter: General ─────────────────────────────────────────────────────────
// Protege todas las rutas contra flooding / DDoS básico.

export const generalLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max:      200,
  message:  'Demasiadas solicitudes. Intenta de nuevo más tarde.',
});

// ─── Limiters: Auth (solo endpoints de mutación con riesgo brute-force) ───────

/**
 * Login — el endpoint más crítico.
 * 5 intentos fallidos / 15 min / IP antes de bloquear.
 */
export const loginLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max:      5,
  message:  'Demasiados intentos de inicio de sesión. Espera 15 minutos e intenta de nuevo.',
});

/**
 * Registro — evita creación masiva de cuentas.
 * 5 registros / hora / IP.
 */
export const registerLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max:      5,
  message:  'Demasiadas solicitudes de registro desde esta red. Intenta más tarde.',
});

/**
 * Forgot password — evita enumeración de emails y spam.
 * 3 solicitudes / hora / IP.
 */
export const forgotPasswordLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max:      3,
  message:  'Demasiadas solicitudes de recuperación de contraseña. Intenta en una hora.',
});

/**
 * Reset password — evita fuerza bruta sobre el token de reset.
 * 5 intentos / hora / IP.
 */
export const resetPasswordLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max:      5,
  message:  'Demasiados intentos de restablecimiento de contraseña. Intenta en una hora.',
});

// ─── Limiter: Pagos ───────────────────────────────────────────────────────────
// Previene abuso de endpoints de creación de órdenes.

export const paymentsLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 minuto
  max:      20,
  message:  'Límite de solicitudes de pago excedido. Intenta de nuevo en un minuto.',
});
