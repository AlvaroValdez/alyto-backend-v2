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

    const returnUrl = `${process.env.APP_URL ?? 'http://localhost:5173'}/kyc/return`;

    const session = await getStripe().identity.verificationSessions.create({
      type: 'document',
      options: {
        document: {
          require_live_capture:    true,
          require_matching_selfie: true,
          allowed_types: ['driving_license', 'id_card', 'passport'],
        },
      },
      return_url: returnUrl,
      metadata: {
        userId,
        legalEntity: user.legalEntity,
        email:       user.email,
      },
    });

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
    console.error('[KYC] Error creando session:', err.message);
    return res.status(500).json({ error: 'Error al iniciar la verificación de identidad.' });
  }
}

// ─── getKycStatus ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/kyc/status
 * Requiere JWT (middleware protect).
 *
 * Devuelve el estado KYC actual del usuario. El frontend hace polling
 * a este endpoint cada 3 segundos mientras kycStatus === 'in_review'.
 *
 * @returns {{ kycStatus: string }}
 */
export async function getKycStatus(req, res) {
  try {
    const user = await User.findById(req.user._id).select('kycStatus kycApprovedAt');

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
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
