/**
 * kycTelemetry.js — Registro del intento de verificación de identidad.
 *
 * Todas las funciones son best-effort por diseño (regla 13): un fallo al anotar
 * el intento jamás puede impedir que el usuario verifique su identidad. Los
 * errores se dejan en bitácora y no se propagan.
 *
 * Ver [KycAttempt] para qué responde cada campo.
 */

import KycAttempt from '../models/KycAttempt.js';
import { logger }  from '../utils/logger.js';

/** Plataformas que el cliente puede declarar; cualquier otra cosa es 'unknown'. */
const PLATFORMS = new Set(['native', 'mobile-web', 'desktop']);

/**
 * Normaliza la plataforma declarada por el cliente. No confiamos en el valor
 * crudo: llega por querystring y termina en un campo con enum.
 */
export function normalizePlatform(raw) {
  return PLATFORMS.has(raw) ? raw : 'unknown';
}

/**
 * Dirección de origen real. Detrás del proxy, `req.ip` ya respeta `trust proxy`;
 * dejamos el encabezado como respaldo por si el despliegue cambia.
 */
function clientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.ip ?? null;
}

/**
 * Abre el registro del intento al crear la sesión en Stripe.
 *
 * @param {{user: object, sessionId: string, platform: string, req: object}} args
 */
export async function openKycAttempt({ user, sessionId, platform, req }) {
  try {
    await KycAttempt.create({
      userId:      user._id,
      email:       user.email ?? null,
      legalEntity: user.legalEntity ?? null,
      sessionId,
      platform:    normalizePlatform(platform),
      userAgent:   (req?.headers?.['user-agent'] ?? '').slice(0, 500) || null,
      ip:          clientIp(req),
      outcome:     'open',
    });

    // Abrir un intento nuevo confirma que el anterior no llegó a término: el
    // usuario tuvo que volver a la aplicación y pulsar otra vez. Es el momento
    // exacto en que se puede detectar a alguien que está bloqueado, sin esperas
    // ni suposiciones. Fire-and-forget: avisar a administración nunca puede
    // impedir que el usuario empiece su verificación.
    import('./kycBlockedAlert.js')
      .then(({ revisarBloqueoKyc }) => revisarBloqueoKyc(user, sessionId))
      .catch(err => logger.warn('[KYC Telemetría] Revisión de bloqueo omitida', {
        sessionId, error: err.message,
      }));
  } catch (err) {
    logger.warn('[KYC Telemetría] No se pudo abrir el intento', { sessionId, error: err.message });
  }
}

/**
 * Anota un hito sobre un intento ya abierto, sin tocar su desenlace.
 *
 * @param {string} sessionId
 * @param {{returnedAt?: Date, restartedAt?: Date}} patch
 */
export async function markKycAttempt(sessionId, patch) {
  if (!sessionId) return;
  try {
    await KycAttempt.updateOne({ sessionId }, { $set: patch });
  } catch (err) {
    logger.warn('[KYC Telemetría] No se pudo anotar el hito', { sessionId, error: err.message });
  }
}

/**
 * Cierra el intento con su desenlace. Idempotente: un intento ya cerrado no se
 * reabre ni se pisa (el polling y el webhook pueden resolver la misma sesión).
 *
 * @param {string} sessionId
 * @param {{outcome: string, stripeStatus?: string, stripeErrorCode?: string}} result
 */
export async function closeKycAttempt(sessionId, { outcome, stripeStatus = null, stripeErrorCode = null }) {
  if (!sessionId) return;
  try {
    await KycAttempt.updateOne(
      { sessionId, outcome: 'open' },
      { $set: { outcome, outcomeAt: new Date(), stripeStatus, stripeErrorCode } },
    );
  } catch (err) {
    logger.warn('[KYC Telemetría] No se pudo cerrar el intento', { sessionId, error: err.message });
  }
}

export default { openKycAttempt, markKycAttempt, closeKycAttempt, normalizePlatform };
