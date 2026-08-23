/**
 * sep10Middleware.js — Validación de tokens SEP-10
 *
 * Los endpoints SEP-12/24/31 requieren autenticación SEP-10.
 * El token puede ser:
 *   a) JWT Alyto estándar (usuario registrado — contiene id + stellarAccount)
 *   b) JWT SEP-10 puro (solo stellarAccount — para interoperabilidad con wallets externas)
 *
 * El middleware popula req.user con los datos disponibles.
 */

import jwt  from 'jsonwebtoken';
import User from '../models/User.js';
import { logger } from '../utils/logger.js';
import { isScopedToken } from '../services/authTokenService.js';

/**
 * Middleware que acepta tokens JWT Alyto (SEP-10 verify) o tokens SEP-10 puros.
 * Si el token contiene `id`, carga el usuario completo desde MongoDB.
 * Si solo contiene `stellarAccount`, el acceso es limitado (interop con wallets externas).
 */
export async function sep10Protect(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization: Bearer <token> required' });
    }

    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Una credencial de propósito acotado no es una sesión. La intermedia del
    // segundo factor lleva el mismo `id` que una sesión real: sin este rechazo,
    // quien acertó la contraseña de un administrador entraría por aquí a las
    // rutas del anchor sin haber presentado nunca el segundo factor.
    if (isScopedToken(decoded)) {
      return res.status(401).json({ error: 'Second factor verification not completed' });
    }

    // Token con userId (usuario Alyto registrado)
    if (decoded.id) {
      const user = await User.findById(decoded.id)
        .select('firstName lastName email kycStatus legalEntity accountType sanctionsFlag stellarAccount isActive tokenVersion')
        .lean();

      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      // Mismos guards que protect() (audit 2026-06-11): cuenta suspendida,
      // flag de sanciones y revocación server-side por tokenVersion.
      if (user.isActive === false) {
        return res.status(401).json({ error: 'Account suspended' });
      }
      if (user.sanctionsFlag === true) {
        return res.status(403).json({ error: 'Account restricted' });
      }
      const skipTokenVersionCheck = process.env.DISABLE_TOKEN_VERSION_CHECK === 'true';
      if (process.env.NODE_ENV === 'production' && !skipTokenVersionCheck) {
        if ((decoded.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
          return res.status(401).json({ error: 'Token revoked' });
        }
      }

      req.user = {
        ...user,
        _id: user._id,
        stellarAccount: decoded.stellarAccount ?? user.stellarAccount?.publicKey,
      };
      return next();
    }

    // Token SEP-10 puro (solo stellarAccount — wallet externa)
    if (decoded.stellarAccount) {
      req.user = {
        stellarAccount: decoded.stellarAccount,
        _id:            null,
        isSep10Only:    true,
      };
      return next();
    }

    return res.status(401).json({ error: 'Invalid SEP-10 token' });

  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    logger.error('[sep10Middleware] Token validation error', { err: err.message });
    return res.status(401).json({ error: 'Invalid token' });
  }
}
