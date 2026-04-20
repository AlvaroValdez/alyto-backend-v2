/**
 * authMiddleware.js — Middleware de Autenticación y Autorización Multi-Entidad
 *
 * protect(req, res, next)
 *   Verifica el token JWT en el header Authorization: Bearer <token>.
 *   Si es válido, adjunta el usuario a req.user para los siguientes handlers.
 *
 * requireEntity(entityTypes)
 *   Fábrica de middleware que restringe el acceso según la entidad legal del usuario.
 *   Verifica que req.user.legalEntity esté en el array entityTypes permitido.
 *
 *   Uso:
 *     router.post('/payin/fintoc', protect, requireEntity(['SpA']), handler);
 *     router.post('/onramp/owlpay', protect, requireEntity(['LLC']), handler);
 */

import jwt  from 'jsonwebtoken';
import User from '../models/User.js';
import { setSentryUser } from './sentryContext.js';
import { BoundedCache } from '../utils/boundedCache.js';

// ─── Cache de usuarios autenticados ──────────────────────────────────────────
// Evita una query MongoDB en cada request autenticado.
// TTL: 5 min — suficiente para flujos normales.
// Se invalida en logout (el token expira, decoded.id ya no matchea con TTL).
// Para cambios críticos post-login (ej. cuenta suspendida), el TTL máximo
// de 5 min es el delay aceptable antes de que el middleware lo detecte.

const USER_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutos — reducido para acotar ventana de revocación
const USER_CACHE_MAX    = 1000;
// BoundedCache: evita crecimiento ilimitado bajo tráfico sostenido.
export const userCache = new BoundedCache(USER_CACHE_MAX, USER_CACHE_TTL_MS);

function getCachedUser(userId) {
  return userCache.get(userId) ?? null;
}

function setCachedUser(userId, user) {
  userCache.set(userId, user);
}

/** Invalida el cache de un usuario (usar en logout o cambio de estado) */
export function invalidateUserCache(userId) {
  userCache.delete(String(userId));
}

// ─── protect ─────────────────────────────────────────────────────────────────

/**
 * Middleware que valida el JWT y carga el usuario autenticado en req.user.
 *
 * Flujo:
 *  1. Extrae el token del header Authorization: Bearer <token>
 *  2. Verifica la firma y expiración con JWT_SECRET
 *  3. Carga el User desde MongoDB (sin el campo password)
 *  4. Rechaza si el usuario fue eliminado o desactivado tras emitir el token
 */
export async function protect(req, res, next) {
  // 1) Cookie HttpOnly (modo principal); 2) Authorization: Bearer (fallback para API/mobile)
  const token = req.cookies?.alyto_token
    ?? (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.split(' ')[1]
        : null);

  if (!token) {
    return res.status(401).json({
      error: 'No autorizado. Token no proporcionado.',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Cargar usuario desde cache o DB.
    // Cache TTL 2 min — acota la ventana de revocación por tokenVersion.
    let user = getCachedUser(decoded.id);
    if (!user) {
      user = await User.findById(decoded.id)
        .select('_id email firstName lastName legalEntity role kycStatus kybStatus accountType isActive residenceCountry stellarAccount fcmTokens businessProfileId tokenVersion')
        .lean();
      if (user) setCachedUser(decoded.id, user);
    }

    if (!user) {
      return res.status(401).json({
        error: 'No autorizado. Usuario no encontrado o eliminado.',
      });
    }

    if (!user.isActive) {
      invalidateUserCache(decoded.id); // Limpiar cache si la cuenta fue suspendida
      return res.status(401).json({
        error: 'No autorizado. Cuenta suspendida.',
      });
    }

    // Revocación server-side: el user puede haber invalidado tokens (logout,
    // password reset, suspensión) incrementando tokenVersion.
    const userTokenVersion = user.tokenVersion ?? 0;
    const jwtTokenVersion  = decoded.tokenVersion ?? 0;
    console.log('[Protect] JWT tokenVersion:', jwtTokenVersion,
      '| DB tokenVersion:', userTokenVersion,
      '| match:', jwtTokenVersion === userTokenVersion);
    if (jwtTokenVersion !== userTokenVersion) {
      console.warn('[Protect] tokenVersion mismatch —',
        'JWT:', jwtTokenVersion, '!== DB:', userTokenVersion);
      return res.status(401).json({
        error: 'Session expired',
      });
    }

    req.user = user;
    // .lean() devuelve POJO sin el getter virtual `id` de Mongoose.
    // Lo añadimos manualmente para compatibilidad con controllers que usen req.user.id
    if (user._id && !user.id) {
      user.id = user._id.toString();
    }
    setSentryUser(user);
    next();

  } catch (err) {
    // Distinguir token expirado de firma inválida para mejor diagnóstico
    const message = err.name === 'TokenExpiredError'
      ? 'No autorizado. Token expirado.'
      : 'No autorizado. Token inválido.';

    return res.status(401).json({ error: message });
  }
}

// ─── requireEntity ────────────────────────────────────────────────────────────

/**
 * Fábrica de middleware para control de acceso por entidad legal (jurisdicción).
 *
 * La entidad legal del usuario (req.user.legalEntity) determina qué proveedores
 * y corredores de pago están disponibles en cada operación:
 *
 *   'LLC' → AV Finance LLC (Delaware)  — clientes corporativos / origen EE.UU.
 *   'SpA' → AV Finance SpA (Chile)     — usuarios con origen CL (Fintoc, etc.)
 *   'SRL' → AV Finance SRL (Bolivia)   — usuarios con destino BO (Anchor Manual)
 *
 * @param {string[]} entityTypes — Entidades autorizadas para la ruta. Ej: ['SpA']
 * @returns {Function} Middleware Express
 */
// ─── requireAdmin ─────────────────────────────────────────────────────────────

/**
 * Middleware que restringe el acceso exclusivamente a usuarios con role = 'admin'.
 * Debe ejecutarse después de protect() — req.user debe estar disponible.
 *
 * Uso:
 *   router.get('/users', protect, requireAdmin, handler);
 */
export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: 'No autorizado. Middleware protect() no ejecutado.',
    });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Acceso denegado. Se requiere rol de administrador.',
    });
  }

  next();
}

// ─── requireKycApproved ───────────────────────────────────────────────────────

/**
 * Middleware que bloquea el acceso a rutas que requieren KYC aprobado.
 * Debe ejecutarse después de protect() — req.user debe estar disponible.
 *
 * Uso:
 *   router.post('/payments/initiate', protect, requireKycApproved, handler);
 */
export function requireKycApproved(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'No autenticado' });
  }
  if (req.user.kycStatus !== 'approved') {
    return res.status(403).json({
      success: false,
      message: 'Debes verificar tu identidad antes de continuar.',
      code:    'KYC_REQUIRED',
    });
  }
  next();
}

// ─── requireEntity ────────────────────────────────────────────────────────────

export function requireEntity(entityTypes) {
  return (req, res, next) => {
    // protect() debe ejecutarse antes — req.user debe estar disponible
    if (!req.user) {
      return res.status(401).json({
        error: 'No autorizado. Middleware protect() no ejecutado.',
      });
    }

    const userEntity = req.user.legalEntity;

    if (!entityTypes.includes(userEntity)) {
      return res.status(403).json({
        error:            `Acceso denegado. Esta operación requiere una cuenta bajo: ${entityTypes.join(' o ')}.`,
        requiredEntities: entityTypes,
        userEntity:       userEntity,
      });
    }

    next();
  };
}
