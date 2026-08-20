/**
 * sandboxOnly.js — Guard de entorno para endpoints de simulación.
 *
 * Un endpoint "simulate*" fabrica el efecto de un evento externo que nunca
 * ocurrió: acredita un depósito sin que el banco haya cobrado, confirma un
 * payin sin dinero detrás, cierra un retiro sin que el banco lo haya liquidado.
 * En sandbox es una herramienta de prueba; en producción es una vía directa
 * para crear saldo de la nada sobre fondos de terceros bajo custodia.
 *
 * El patrón ya existía inline en adminRoutes.js (endpoint sandbox de OwlPay);
 * aquí se centraliza para que ningún simulador nuevo nazca sin guard.
 *
 * Uso en rutas:
 *   router.post('/transactions/:id/simulate-x', sandboxOnly, handler);
 *
 * Uso dentro de un handler (defensa en profundidad, para los que mueven saldo):
 *   if (denyIfProduction(res, 'simulate-bankqr-payment')) return;
 *
 * Para habilitarlos en Render staging (NODE_ENV=production sin Secrets Manager):
 *   ALYTO_SANDBOX_SIMULATORS=true
 * En el VPS de producción ese flag se ignora.
 *
 * La política de entorno vive en utils/environment.js — la comparte con la rama
 * de autoconfirmación de payouts de dispatchPayout, que corre el mismo riesgo
 * (dar por liquidada una operación que nadie ejecutó) fuera de una ruta HTTP.
 */

import { logger } from '../utils/logger.js';
import { areSimulatorsAllowed } from '../utils/environment.js';

const DENIED_BODY = Object.freeze({
  error: 'Endpoint de simulación deshabilitado en este entorno.',
  code:  'SANDBOX_ONLY',
});

/**
 * Middleware Express: 403 donde los simuladores están vedados, `next()` si no.
 * @type {import('express').RequestHandler}
 */
export function sandboxOnly(req, res, next) {
  if (areSimulatorsAllowed()) return next();

  logger.warn('[sandboxOnly] Intento de simulación bloqueado', {
    path:       req.originalUrl ?? req.path,
    actorId:    req.user?._id ? String(req.user._id) : null,
    actorEmail: req.user?.email ?? null,
  });
  return res.status(403).json({ ...DENIED_BODY });
}

/**
 * Variante para usar dentro de un handler. Responde 403 y devuelve `true` si
 * la llamada fue rechazada — el caller debe hacer `return` inmediatamente.
 *
 * @param {import('express').Response} res
 * @param {string} endpointLabel — nombre del simulador, solo para el log
 * @returns {boolean} true si ya se respondió 403
 */
export function denyIfProduction(res, endpointLabel = 'simulate') {
  if (areSimulatorsAllowed()) return false;

  logger.warn('[sandboxOnly] Intento de simulación bloqueado', { endpoint: endpointLabel });
  res.status(403).json({ ...DENIED_BODY });
  return true;
}

export default sandboxOnly;
