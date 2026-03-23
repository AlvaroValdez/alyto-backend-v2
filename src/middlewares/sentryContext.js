/**
 * sentryContext.js — Middleware de contexto Sentry para Alyto Backend V2.0
 *
 * Enriquece cada request con metadatos de negocio relevantes para Sentry:
 *   - Usuario autenticado (id, email, rol, entidad legal)
 *   - Tags de transacción (alytoTransactionId, corridorId)
 *
 * Registro en server.js: después de los middlewares de body-parsing.
 * El contexto de usuario se establece en authMiddleware.protect() donde
 * req.user ya está disponible, no aquí (este middleware se ejecuta antes
 * de que JWT verifique el token).
 */

import Sentry from '../services/sentry.js';

/**
 * Middleware global: agrega tags de transacción disponibles en el request.
 * Se ejecuta antes de las rutas — solo lee params y body que ya están parseados.
 */
export function sentryContext(req, res, next) {
  // ── Tags de transacción (disponibles antes de auth) ───────────────────────
  const transactionId =
    req.params?.transactionId ??
    req.params?.id ??
    req.body?.transactionId ??
    req.body?.alytoTransactionId ??
    null;

  const corridorId =
    req.params?.corridorId ??
    req.body?.corridorId ??
    null;

  if (transactionId) {
    Sentry.setTag('transactionId', transactionId);
  }

  if (corridorId) {
    Sentry.setTag('corridorId', corridorId);
  }

  next();
}

/**
 * Establece el contexto de usuario en Sentry.
 * Llamar desde protect() en authMiddleware.js después de fijar req.user.
 *
 * @param {object} user — Documento Mongoose del usuario autenticado
 */
export function setSentryUser(user) {
  if (!user) return;
  Sentry.setUser({
    id:     user._id?.toString(),
    email:  user.email,
    role:   user.role,
    entity: user.legalEntity,
  });
}
