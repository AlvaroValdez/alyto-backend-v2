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
  let token;

  if (req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({
      error: 'No autorizado. Token no proporcionado.',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Cargar usuario fresco de DB — detecta cuentas desactivadas post-emisión
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return res.status(401).json({
        error: 'No autorizado. Usuario no encontrado o eliminado.',
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        error: 'No autorizado. Cuenta suspendida.',
      });
    }

    req.user = user;
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
