/**
 * kycSessionResolver.js — Única traducción de una VerificationSession de Stripe
 * a un `kycStatus` de Alyto.
 *
 * Esta lógica vivía incrustada en `getKycStatus`, así que solo corría cuando el
 * usuario tenía la pantalla abierta haciendo polling. Si cerraba la aplicación
 * mientras la sesión seguía sin resolverse, quedaba en 'in_review' para siempre:
 * el 2026-10-02 había un usuario así desde el 2026-08-29. Extraerla permite que
 * el barrido periódico ([kycStaleSessionSweeper]) aplique exactamente el mismo
 * criterio sin reimplementarlo, que es como aparecen las divergencias.
 *
 * Reglas (idénticas a las que ya aplicaba el polling):
 *   verified                              → aprobar (reusa el hook del webhook)
 *   requires_input + error definitivo     → rechazar
 *   requires_input + error recuperable    → volver a 'pending' para reintentar
 *   requires_input + sin error + vieja    → volver a 'pending' (abandonada)
 *   requires_input + sin error + reciente → sigue 'in_review' (captura en curso)
 *   canceled                              → volver a 'pending'
 *   processing                            → sin cambios, Stripe todavía resuelve
 */

import Stripe from 'stripe';
import User    from '../models/User.js';
import { invalidateUserCache }  from '../middlewares/authMiddleware.js';
import { approveKycFromSession } from '../webhooks/stripeWebhook.js';
import { closeKycAttempt }       from './kycTelemetry.js';
import { logger }                from '../utils/logger.js';

let _stripe = null;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

/** Errores de Stripe Identity que implican rechazo definitivo. */
export const HARD_REJECTION_CODES = new Set([
  'document_expired',
  'document_type_not_supported',
  'document_unverified_other',
  'selfie_face_mismatch',
  'selfie_manipulated',
  'selfie_unverified_other',
]);

/**
 * Antigüedad a partir de la cual una sesión 'requires_input' SIN error se
 * considera abandonada. Debe superar holgadamente lo que tarda una verificación
 * normal (~2-5 min), porque durante la captura la sesión se ve exactamente igual
 * que una que nunca se abrió.
 *
 * Se lee dentro de la función a propósito (regla 21): en el ámbito del módulo
 * capturaría el valor previo a la carga de secretos.
 */
export function kycSessionStaleMs() {
  return Number(process.env.KYC_SESSION_STALE_MIN || 15) * 60 * 1000;
}

/**
 * Resuelve el estado KYC de un usuario contra su sesión de Stripe y persiste el
 * cambio cuando corresponde.
 *
 * @param {{_id: any, kycStatus: string, stripeVerificationSessionId: string}} user
 * @param {{session?: object}} [opts] Sesión ya recuperada, para no volver a pedirla.
 * @returns {Promise<{kycStatus: string, kycApprovedAt: Date|null, changed: boolean, reason: string}>}
 */
export async function resolveKycFromStripe(user, opts = {}) {
  const sessionId = user.stripeVerificationSessionId;
  if (!sessionId) {
    return { kycStatus: user.kycStatus, kycApprovedAt: null, changed: false, reason: 'sin_sesion' };
  }

  const session = opts.session
    ?? await getStripe().identity.verificationSessions.retrieve(sessionId);

  logger.info('[KYC Resolver] Sesión consultada', {
    sessionId:  session.id,
    status:     session.status,
    lastError:  session.last_error?.code ?? null,
    userId:     String(user._id),
  });

  if (session.status === 'verified') {
    // El webhook pudo no llegar. Reusar su hook aplica TODOS los efectos
    // (verified_outputs, screening AML, keypair custodial, notificación).
    await approveKycFromSession(session);
    await closeKycAttempt(sessionId, { outcome: 'approved', stripeStatus: session.status });
    return { kycStatus: 'approved', kycApprovedAt: new Date(), changed: true, reason: 'verificada' };
  }

  if (session.status === 'requires_input') {
    const errorCode = session.last_error?.code ?? null;

    if (errorCode && HARD_REJECTION_CODES.has(errorCode)) {
      await User.findByIdAndUpdate(user._id, {
        kycStatus:     'rejected',
        kycRejectedAt: new Date(),
        kycErrorCode:  errorCode,
      });
      invalidateUserCache(user._id);
      await closeKycAttempt(sessionId, {
        outcome: 'rejected', stripeStatus: session.status, stripeErrorCode: errorCode,
      });
      logger.info('[KYC Resolver] Rechazo definitivo', { userId: String(user._id), errorCode });
      return { kycStatus: 'rejected', kycApprovedAt: null, changed: true, reason: errorCode };
    }

    const ageMs   = session.created ? Date.now() - session.created * 1000 : 0;
    const isStale = ageMs > kycSessionStaleMs();

    if (errorCode || isStale) {
      let changed = false;
      if (user.kycStatus !== 'pending') {
        await User.findByIdAndUpdate(user._id, { kycStatus: 'pending' });
        invalidateUserCache(user._id);
        changed = true;
      }
      await closeKycAttempt(sessionId, {
        outcome: 'abandoned', stripeStatus: session.status, stripeErrorCode: errorCode,
      });
      const reason = errorCode ?? `sin_error_${Math.round(ageMs / 60000)}min`;
      logger.info('[KYC Resolver] Sesión recuperable, vuelve a pending', {
        userId: String(user._id), reason, changed,
      });
      return { kycStatus: 'pending', kycApprovedAt: null, changed, reason };
    }

    // Verificación en curso: mantener in_review y seguir consultando.
    return { kycStatus: 'in_review', kycApprovedAt: null, changed: false, reason: 'en_curso' };
  }

  if (session.status === 'canceled') {
    let changed = false;
    if (user.kycStatus !== 'pending') {
      await User.findByIdAndUpdate(user._id, { kycStatus: 'pending' });
      invalidateUserCache(user._id);
      changed = true;
    }
    await closeKycAttempt(sessionId, { outcome: 'abandoned', stripeStatus: session.status });
    return { kycStatus: 'pending', kycApprovedAt: null, changed, reason: 'cancelada' };
  }

  // 'processing' → Stripe todavía está resolviendo; no tocar nada.
  return { kycStatus: user.kycStatus, kycApprovedAt: null, changed: false, reason: session.status };
}

export default { resolveKycFromStripe, HARD_REJECTION_CODES, kycSessionStaleMs };
