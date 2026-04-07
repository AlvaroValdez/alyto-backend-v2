/**
 * kycController.js — Endpoints de estado KYC del usuario
 *
 * GET /api/v1/kyc/session  → Crea VerificationSession de Stripe Identity
 * GET /api/v1/kyc/status   → Devuelve el kycStatus actual del usuario autenticado
 *
 * Nota: La sesión biométrica delega la lógica al identityController.
 */

import Stripe from 'stripe';
import User   from '../models/User.js';
import { invalidateUserCache } from '../middlewares/authMiddleware.js';

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

    // allowed_countries solo funciona en producción con aprobación Stripe.
    // En sandbox Stripe lo rechaza con parameter_unknown.
    const isLive = process.env.STRIPE_SECRET_KEY?.startsWith('sk_live');
    const documentOptions = {
      require_live_capture:    true,
      require_matching_selfie: true,
      allowed_types: ['driving_license', 'id_card', 'passport'],
      ...(isLive && {
        allowed_countries: ['BO', 'CL', 'US', 'AR', 'CO', 'PE', 'MX', 'BR',
                            'EC', 'VE', 'UY', 'PY', 'CA', 'GB', 'DE', 'FR',
                            'ES', 'IT', 'AU', 'CN', 'AE'],
      }),
    };

    const flowId = process.env.STRIPE_IDENTITY_FLOW_ID
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
    // Usar el flujo configurado en el dashboard si está disponible
    if (flowId) {
      sessionParams.verification_flow = flowId
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
        }

        // session.status === 'processing' o error recuperable → seguir esperando
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
  if (process.env.NODE_ENV === 'production') {
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
      { new: true },
    ).select('email kycStatus kycApprovedAt legalEntity');

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    console.info(`[KYC Test] ✅ KYC aprobado manualmente — userId: ${userId} | email: ${user.email}`);

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
  if (process.env.NODE_ENV === 'production') {
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
