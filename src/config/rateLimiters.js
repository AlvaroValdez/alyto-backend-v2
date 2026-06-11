/**
 * rateLimiters.js — Configuración centralizada de Rate Limiting por entorno
 *
 * Estrategia:
 *   - NODE_ENV=test           → sin límites (suites automatizadas)
 *   - RATE_LIMIT_STRICT=false → límites permisivos para staging/testing
 *                               bypass adicional vía header x-bypass-rate-limit
 *   - RATE_LIMIT_STRICT=true  → límites estrictos (producción VPS)
 *                               sin bypass posible
 *
 * Configurar en Render (staging): RATE_LIMIT_STRICT=false
 * Configurar en VPS   (prod):     RATE_LIMIT_STRICT=true  (o no definir)
 *
 * Limiters disponibles:
 *   loginLimiter          → POST /auth/login           strict: 5/15min  | permissive: 50/15min
 *   registerLimiter       → POST /auth/register        strict: 5/h      | permissive: 30/h
 *   forgotPasswordLimiter → POST /auth/forgot-password strict: 3/h      | permissive: 20/h
 *   resetPasswordLimiter  → POST /auth/reset-password  strict: 5/h      | permissive: 30/h
 *   generalLimiter        → todas las rutas            strict: 200/15min | permissive: 1000/15min
 *   paymentsLimiter       → /api/v1/payments/*         strict: 20/min   | permissive: 100/min
 */

import rateLimit from 'express-rate-limit';

const ENV       = process.env.NODE_ENV ?? 'development';
const IS_TEST   = ENV === 'test';
// RATE_LIMIT_STRICT=false en staging → límites permisivos para tests automatizados.
// Por defecto strict=true (producción). VPS debe tener RATE_LIMIT_STRICT=true o no definirla.
const IS_STRICT = process.env.RATE_LIMIT_STRICT !== 'false';

// ─── Skip handler ─────────────────────────────────────────────────────────────
// En test: siempre skip.
// En staging (RATE_LIMIT_STRICT=false) + header bypass correcto: skip.
// En producción estricta: nunca skip.

function skip(req) {
  if (IS_TEST) return true;
  if (
    !IS_STRICT &&
    process.env.DEV_RATE_LIMIT_BYPASS_KEY &&
    req.headers['x-bypass-rate-limit'] === process.env.DEV_RATE_LIMIT_BYPASS_KEY
  ) {
    return true;
  }
  return false;
}

// ─── Factory helper ───────────────────────────────────────────────────────────

function makeLimiter({ windowMs, max, maxPermissive, message }) {
  return rateLimit({
    windowMs,
    max: IS_STRICT ? max : (maxPermissive ?? max * 10),
    skip,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { error: message },
  });
}

// ─── Limiter: General ─────────────────────────────────────────────────────────

export const generalLimiter = makeLimiter({
  windowMs:      15 * 60 * 1000,
  max:           200,
  maxPermissive: 1000,
  message:       'Demasiadas solicitudes. Intenta de nuevo más tarde.',
});

// ─── Limiters: Auth ───────────────────────────────────────────────────────────

export const loginLimiter = makeLimiter({
  windowMs:      15 * 60 * 1000,
  max:           5,
  maxPermissive: 50,
  message:       'Demasiados intentos de inicio de sesión. Espera 15 minutos e intenta de nuevo.',
});

export const registerLimiter = makeLimiter({
  windowMs:      60 * 60 * 1000,
  max:           5,
  maxPermissive: 30,
  message:       'Demasiadas solicitudes de registro desde esta red. Intenta más tarde.',
});

export const forgotPasswordLimiter = makeLimiter({
  windowMs:      60 * 60 * 1000,
  max:           3,
  maxPermissive: 20,
  message:       'Demasiadas solicitudes de recuperación de contraseña. Intenta en una hora.',
});

export const resetPasswordLimiter = makeLimiter({
  windowMs:      60 * 60 * 1000,
  max:           5,
  maxPermissive: 30,
  message:       'Demasiados intentos de restablecimiento de contraseña. Intenta en una hora.',
});

// ─── Limiter: Pagos ───────────────────────────────────────────────────────────

export const paymentsLimiter = makeLimiter({
  windowMs:      60 * 1000,
  max:           20,
  maxPermissive: 100,
  message:       'Límite de solicitudes de pago excedido. Intenta de nuevo en un minuto.',
});

// ─── Limiter: Operaciones financieras de Wallet (send/QR/convert/withdraw) ─────
// Audit 2026-06-11: estos endpoints solo tenían el generalLimiter (200/15min).

export const walletOpsLimiter = makeLimiter({
  windowMs:      60 * 1000,
  max:           15,
  maxPermissive: 100,
  message:       'Límite de operaciones de wallet excedido. Intenta de nuevo en un minuto.',
});

// ─── Limiter: KYC session (cada llamada crea una sesión en Stripe = costo) ─────

export const kycSessionLimiter = makeLimiter({
  windowMs:      60 * 60 * 1000,
  max:           10,
  maxPermissive: 60,
  message:       'Demasiadas solicitudes de verificación de identidad. Intenta más tarde.',
});
