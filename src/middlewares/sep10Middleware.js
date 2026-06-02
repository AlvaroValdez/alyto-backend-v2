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

    // Token con userId (usuario Alyto registrado)
    if (decoded.id) {
      const user = await User.findById(decoded.id)
        .select('firstName lastName email kycStatus legalEntity accountType sanctionsFlag stellarAccount')
        .lean();

      if (!user) {
        return res.status(401).json({ error: 'User not found' });
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
