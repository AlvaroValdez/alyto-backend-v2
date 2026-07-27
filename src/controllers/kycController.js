/**
 * kycController.js — Endpoints de estado KYC del usuario
 *
 * GET /api/v1/kyc/session  → Crea VerificationSession de Stripe Identity
 * GET /api/v1/kyc/status   → Devuelve el kycStatus actual del usuario autenticado
 */

import Stripe          from 'stripe';
import User             from '../models/User.js';
import { invalidateUserCache } from '../middlewares/authMiddleware.js';
import { screenUser }   from '../services/sanctionsService.js';

let _stripe = null;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// ─── createKycSession ─────────────────────────────────────────────────────────

/**
 * GET /api/v1/kyc/session
 * Requiere JWT (middleware protect).
 *
 * Crea una VerificationSession de Stripe Identity y devuelve la client_secret
 * necesaria para abrir el modal nativo en el frontend.
 *
 * @returns {{ clientSecret: string, sessionId: string }}
 */
export async function createKycSession(req, res) {
  try {
    const user   = req.user;
    const userId = user._id.toString();

    // FRONTEND_URL debe apuntar al frontend (https://alyto-frontend-v2.onrender.com).
    // NO usar APP_URL — esa variable puede apuntar al backend (ngrok tunnel en dev).
    const returnUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/kyc/return`;

    // NOTA: Stripe Identity NO soporta `allowed_countries` vía API (rechaza con
    // parameter_unknown "Did you mean allowed_types?"). La restricción por país/
    // entidad se hace en código (gating por legalEntity), no en este parámetro.
    const documentOptions = {
      require_live_capture:    true,
      require_matching_selfie: true,
      allowed_types: ['driving_license', 'id_card', 'passport'],
    };

    // Sesión con type+options inline (patrón estándar Stripe).
    // NO usar verification_flow junto con type/options — son mutuamente excluyentes.
    const sessionParams = {
      type: 'document',
      options: { document: documentOptions },
      return_url: returnUrl,
      metadata: {
        userId,
        legalEntity: user.legalEntity,
        email:       user.email,
      },
    }
    const session = await getStripe().identity.verificationSessions.create(sessionParams);

    // Persistir sessionId para el lookup en el webhook de Stripe
    await User.findByIdAndUpdate(userId, {
      stripeVerificationSessionId: session.id,
      kycStatus:                   'in_review',
      kycProvider:                 'stripe_identity',
    });

    console.info(`[KYC] Session creada — userId: ${userId} | sessionId: ${session.id}`);

    return res.json({
      clientSecret: session.client_secret,
      sessionId:    session.id,
      url:          session.url,  // Usado para redirect en dispositivos móviles
    });

  } catch (err) {
    console.error('[KYC] Error creando session:', {
      message: err.message,
      type:    err.type,
      code:    err.code,
      param:   err.param,
    });
    const userMessage = err.type === 'StripeInvalidRequestError'
      ? `Error de configuración Stripe: ${err.message}`
      : 'Error al iniciar la verificación de identidad.';
    return res.status(500).json({
      error:      userMessage,
      stripeCode: err.code ?? null,
    });
  }
}

// ─── getKycStatus ─────────────────────────────────────────────────────────────

// Antigüedad a partir de la cual una sesión 'requires_input' SIN error se
// considera abandonada (el usuario cerró sin terminar) y se degrada a 'pending'.
// Debe superar holgadamente lo que tarda una verificación normal (~2-5 min).
const KYC_SESSION_STALE_MS = Number(process.env.KYC_SESSION_STALE_MIN || 15) * 60 * 1000;

// Errores de Stripe Identity que implican rechazo definitivo (mismo set que el webhook)
const HARD_REJECTION_CODES = new Set([
  'document_expired',
  'document_type_not_supported',
  'document_unverified_other',
  'selfie_face_mismatch',
  'selfie_manipulated',
  'selfie_unverified_other',
]);

/**
 * GET /api/v1/kyc/status
 * Requiere JWT (middleware protect).
 *
 * Devuelve el estado KYC actual del usuario. El frontend hace polling
 * a este endpoint cada 3 segundos mientras kycStatus === 'in_review'.
 *
 * Cuando el estado está en 'in_review', consulta directamente a Stripe
 * para resolver el estado sin depender del webhook. Esto garantiza que
 * el usuario siempre vea el resultado correcto, incluso si el webhook
 * tardó o falló.
 *
 * @returns {{ kycStatus: string, kycApprovedAt: string|null }}
 */
export async function getKycStatus(req, res) {
  try {
    const user = await User.findById(req.user._id)
      .select('kycStatus kycApprovedAt stripeVerificationSessionId');

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    // Fast path: estado ya resuelto
    if (user.kycStatus === 'approved' || user.kycStatus === 'rejected') {
      return res.json({
        kycStatus:     user.kycStatus,
        kycApprovedAt: user.kycApprovedAt ?? null,
      });
    }

    // Fallback activo: si está en in_review, consultar Stripe directamente.
    // Esto resuelve el estado aunque el webhook haya fallado o aún no haya llegado.
    if (user.kycStatus === 'in_review' && user.stripeVerificationSessionId) {
      try {
        const session = await getStripe().identity.verificationSessions.retrieve(
          user.stripeVerificationSessionId,
        );

        console.info(
          `[KYC Status] Stripe session ${session.id} → status: ${session.status} | last_error: ${JSON.stringify(session.last_error ?? null)}`,
        );

        if (session.status === 'verified') {
          // Auto-aprobar: el webhook no llegó pero Stripe ya completó la verificación
          await User.findByIdAndUpdate(user._id, {
            kycStatus:     'approved',
            kycApprovedAt: new Date(),
            kycProvider:   'stripe_identity',
          });
          invalidateUserCache(user._id); // forzar refresco del cache del middleware
          console.info(`[KYC Status] ✅ Auto-aprobado por polling — userId: ${user._id}`);
          // Screening AML asíncrono (fire-and-forget) — no bloquea respuesta al usuario
          runSanctionsScreening(user._id, user.firstName, user.lastName, user.identityDocument?.number);
          return res.json({ kycStatus: 'approved', kycApprovedAt: new Date() });
        }

        if (session.status === 'requires_input') {
          const errorCode = session.last_error?.code;
          if (errorCode && HARD_REJECTION_CODES.has(errorCode)) {
            // Auto-rechazar: error definitivo de Stripe
            await User.findByIdAndUpdate(user._id, {
              kycStatus:     'rejected',
              kycRejectedAt: new Date(),
              kycErrorCode:  errorCode,
            });
            invalidateUserCache(user._id); // forzar refresco del cache del middleware
            console.info(`[KYC Status] ❌ Auto-rechazado por polling — userId: ${user._id} | code: ${errorCode}`);
            return res.json({ kycStatus: 'rejected', kycApprovedAt: null });
          }

          // ⚠️ Una sesión RECIÉN creada también está en 'requires_input' sin error
          // mientras el usuario captura documento/selfie (el flujo nativo/móvil
          // hace polling DURANTE la verificación). Degradar a 'pending' en ese
          // momento desactiva este fallback (los polls con 'pending' ya no
          // consultan Stripe) y permite crear una segunda sesión que pisa la
          // primera. Solo tratamos como recuperable si hay un error real
          // (abandoned, consent_declined, device...) o la sesión quedó vieja.
          const sessionAgeMs = session.created ? Date.now() - session.created * 1000 : 0;
          const isStale      = sessionAgeMs > KYC_SESSION_STALE_MS;

          if (errorCode || isStale) {
            // Recuperable: el usuario empezó pero no terminó la biometría. Lo
            // devolvemos a 'pending' para que pueda re-lanzar /kyc/session y
            // reintentar con una sesión nueva (sin esto: polling infinito).
            if (user.kycStatus !== 'pending') {
              await User.findByIdAndUpdate(user._id, { kycStatus: 'pending' });
              invalidateUserCache(user._id);
              console.info(`[KYC Status] ↩️ Sesión recuperable (${errorCode ?? `sin error, ${Math.round(sessionAgeMs / 60000)} min`}) — reset a 'pending' para reintento — userId: ${user._id}`);
            }
            return res.json({ kycStatus: 'pending', kycApprovedAt: null });
          }

          // Verificación en curso — mantener in_review y seguir consultando Stripe.
          return res.json({ kycStatus: 'in_review', kycApprovedAt: null });
        }

        if (session.status === 'canceled') {
          // Sesión cancelada (API/redacción) — sin esto el usuario queda en
          // in_review con polling infinito y sin botón de reintento.
          await User.findByIdAndUpdate(user._id, { kycStatus: 'pending' });
          invalidateUserCache(user._id);
          console.info(`[KYC Status] ↩️ Sesión cancelada — reset a 'pending' para reintento — userId: ${user._id}`);
          return res.json({ kycStatus: 'pending', kycApprovedAt: null });
        }

        // session.status === 'processing' → seguir esperando
      } catch (stripeErr) {
        // Si Stripe falla, devolvemos el estado de DB sin bloquear al usuario
        console.warn(`[KYC Status] No se pudo consultar Stripe: ${stripeErr.message}`);
      }
    }

    return res.json({
      kycStatus:     user.kycStatus,
      kycApprovedAt: user.kycApprovedAt ?? null,
    });

  } catch (err) {
    console.error('[KYC] Error obteniendo estado:', err.message);
    return res.status(500).json({ error: 'Error al obtener el estado de verificación.' });
  }
}

// ─── Helper AML: screening de sanciones post-aprobación KYC ──────────────────

/**
 * Ejecuta el screening AML de forma asíncrona (fire-and-forget).
 * Si encuentra un hit persiste el flag en User para visibilidad en el backoffice.
 * Nunca lanza excepciones — cualquier error queda en consola/Sentry.
 */
function runSanctionsScreening(userId, firstName, lastName, documentNumber) {
  screenUser({ firstName, lastName, documentNumber })
    .then(result => {
      if (!result.isClean) {
        console.warn('[Sanctions KYC] ⚠️ Posible hit al aprobar KYC:', {
          userId: userId?.toString(),
          hits:   result.hits.map(h => `${h.entryId} (${h.listSource})`),
        });
        User.findByIdAndUpdate(userId, {
          sanctionsFlag:       true,
          sanctionsScreenedAt: result.screenedAt,
        }).catch(() => {});
      } else {
        User.findByIdAndUpdate(userId, {
          sanctionsFlag:       false,
          sanctionsScreenedAt: result.screenedAt,
        }).catch(() => {});
      }
    })
    .catch(() => {});
}

// ─── approveKycTest (solo en desarrollo) ──────────────────────────────────────

/**
 * POST /api/v1/kyc/approve-test
 * Solo disponible en NODE_ENV !== 'production'.
 * Aprueba el KYC de un usuario sin pasar por Stripe Identity.
 * Útil para testing de flujos post-KYC sin depender del webhook.
 *
 * Body: { userId: string }
 * Respuesta 200: { message, user: { id, email, kycStatus } }
 */
export async function approveKycTest(req, res) {
  if (process.env.ALYTO_ENABLE_DEV_ROUTES !== '1') {
    return res.status(404).json({ error: 'Not found.' });
  }

  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId es requerido.' });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { kycStatus: 'approved', kycApprovedAt: new Date(), kycProvider: 'dev_test' },
      { returnDocument: 'after' },
    ).select('email kycStatus kycApprovedAt legalEntity');

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    console.info(`[KYC Test] ✅ KYC aprobado manualmente — userId: ${userId}`);

    // Screening AML (fire-and-forget) — también en modo test para cubrir el flujo
    const fullUser = await User.findById(userId).select('firstName lastName identityDocument').lean();
    if (fullUser) {
      runSanctionsScreening(userId, fullUser.firstName, fullUser.lastName, fullUser.identityDocument?.number);
    }

    return res.json({
      message: 'KYC aprobado en modo test',
      user: { id: user._id, email: user.email, kycStatus: user.kycStatus },
    });

  } catch (err) {
    console.error('[KYC Test] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─── getKycDebug (solo en desarrollo) ─────────────────────────────────────────

/**
 * GET /api/v1/kyc/debug/:userId
 * Solo disponible en NODE_ENV !== 'production'.
 * Devuelve el estado KYC completo para diagnóstico de webhooks.
 */
export async function getKycDebug(req, res) {
  if (process.env.ALYTO_ENABLE_DEV_ROUTES !== '1') {
    return res.status(404).json({ error: 'Not found.' });
  }

  try {
    const user = await User.findById(req.params.userId).select(
      'email kycStatus kycApprovedAt kycProvider stripeVerificationSessionId'
    );

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    // Consultar el estado actual de la sesión en Stripe si existe
    let stripeSession = null;
    if (user.stripeVerificationSessionId) {
      try {
        stripeSession = await getStripe().identity.verificationSessions.retrieve(
          user.stripeVerificationSessionId
        );
      } catch (e) {
        stripeSession = { error: e.message };
      }
    }

    return res.json({
      userId:          user._id,
      email:           user.email,
      kycStatus:       user.kycStatus,
      kycApprovedAt:   user.kycApprovedAt ?? null,
      kycProvider:     user.kycProvider ?? null,
      sessionId:       user.stripeVerificationSessionId ?? null,
      stripe: stripeSession ? {
        id:         stripeSession.id,
        status:     stripeSession.status,
        last_error: stripeSession.last_error ?? null,
        created:    stripeSession.created,
      } : null,
    });

  } catch (err) {
    console.error('[KYC Debug] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
