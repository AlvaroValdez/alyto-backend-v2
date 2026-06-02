/**
 * stripeWebhook.js — Receptor de Eventos de Stripe (Identity + Payments)
 *
 * ⚠️  CRÍTICO: Este handler debe recibir el body RAW (Buffer), no parseado como JSON.
 *   En server.js la ruta /api/v1/webhooks/stripe usa express.raw() ANTES de express.json().
 *   Sin el body raw, stripe.webhooks.constructEvent() falla con error de firma.
 *
 * Eventos procesados:
 *
 *   identity.verification_session.verified
 *     → KYC aprobado automáticamente. Actualiza kycStatus a 'approved'.
 *
 *   identity.verification_session.requires_input
 *     → La sesión requiere corrección. Si el error es definitivo (ej. selfie no
 *       coincide, documento vencido) se marca como 'rejected'. Errores recuperables
 *       se ignoran para que el usuario reintente.
 *
 * Lookup de usuario: stripeVerificationSessionId guardado en identityController.
 */

import Stripe          from 'stripe';
import User             from '../models/User.js';
import { invalidateUserCache } from '../middlewares/authMiddleware.js';
import { notify }       from '../services/notifications.js';
import { screenUser }   from '../services/sanctionsService.js';
import { provisionUserKeypair } from '../services/custodyService.js';

// Lazy init — dotenv debe cargar antes de instanciar el cliente
let _stripe = null;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// Errores de Stripe Identity que implican rechazo definitivo
const HARD_REJECTION_CODES = new Set([
  'document_expired',
  'document_type_not_supported',
  'document_unverified_other',
  'selfie_face_mismatch',
  'selfie_manipulated',
  'selfie_unverified_other',
]);

// ─── handleStripeWebhook ──────────────────────────────────────────────────────

/**
 * POST /api/v1/webhooks/stripe
 * Punto de entrada para todos los eventos de Stripe.
 * Verifica la firma HMAC antes de procesar cualquier evento.
 */
export async function handleStripeWebhook(req, res) {
  const sig           = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!endpointSecret) {
    console.error('[Stripe Webhook] STRIPE_WEBHOOK_SECRET no configurado — rechazando solicitud.');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  // ── Verificar firma ─────────────────────────────────────────────────────────
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('[Stripe Webhook] Firma inválida:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.info(`[Stripe Webhook] Evento recibido: ${event.type} | id: ${event.id}`);

  // ── Dispatcher de eventos ────────────────────────────────────────────────────
  try {
    switch (event.type) {

      // ── KYC APROBADO ─────────────────────────────────────────────────────────
      case 'identity.verification_session.verified': {
        const session = event.data.object;
        console.info(
          `[KYC Webhook] ${event.type} | sessionId: ${session.id} | status: ${session.status} | last_error: ${JSON.stringify(session.last_error ?? null)}`
        );
        await _approveKyc(session);
        break;
      }

      // ── KYC REQUIERE CORRECCIÓN / RECHAZADO ──────────────────────────────────
      case 'identity.verification_session.requires_input': {
        const session   = event.data.object;
        const errorCode = session.last_error?.code;
        console.info(
          `[KYC Webhook] ${event.type} | sessionId: ${session.id} | status: ${session.status} | last_error: ${JSON.stringify(session.last_error ?? null)}`
        );

        if (errorCode && HARD_REJECTION_CODES.has(errorCode)) {
          await _rejectKyc(session, errorCode);
        } else {
          console.info(
            `[KYC Webhook] Corrección recuperable — sessionId: ${session.id} | code: ${errorCode ?? 'unknown'}`
          );
        }
        break;
      }

      // ── KYC CANCELADO ────────────────────────────────────────────────────────
      case 'identity.verification_session.canceled': {
        const session = event.data.object;
        console.info(
          `[KYC Webhook] ${event.type} | sessionId: ${session.id} | El usuario canceló la verificación`
        );
        break;
      }

      default:
        // Eventos no gestionados — loguear y responder 200 para evitar reintentos
        console.info(`[Stripe Webhook] Evento no procesado: ${event.type}`);
    }
  } catch (err) {
    // Loguear pero responder 200 para evitar que Stripe reintente indefinidamente
    console.error('[Stripe Webhook] Error procesando evento:', err.message);
  }

  return res.status(200).json({ received: true });
}

// ─── Helpers privados ─────────────────────────────────────────────────────────

async function _approveKyc(session) {
  const user = await User.findOne({ stripeVerificationSessionId: session.id });

  if (!user) {
    console.warn(`[KYC Webhook] Usuario no encontrado para sessionId: ${session.id} — ¿Se guardó stripeVerificationSessionId en la sesión?`);
    return;
  }

  const prevStatus    = user.kycStatus;
  user.kycStatus      = 'approved';
  user.kycApprovedAt  = new Date();
  user.kycProvider    = 'stripe_identity';
  await user.save();
  invalidateUserCache(user._id); // forzar refresco del cache del middleware

  notify(user._id, {
    title: '¡Identidad verificada! ✓',
    body:  'Tu identidad fue verificada exitosamente. Ya puedes empezar a usar Alyto.',
    data:  { type: 'kyc_approved' },
  }).catch(() => {});

  // Screening AML (fire-and-forget) — Fase 28, exigencia ASFI
  screenUser({
    firstName:      user.firstName,
    lastName:       user.lastName,
    documentNumber: user.identityDocument?.number,
  }).then(result => {
    const update = { sanctionsScreenedAt: result.screenedAt, sanctionsFlag: !result.isClean };
    if (!result.isClean) {
      console.warn('[Sanctions KYC Webhook] ⚠️ Posible hit:', {
        userId: user._id?.toString(),
        hits:   result.hits.map(h => `${h.entryId} (${h.listSource})`),
      });
    }
    User.findByIdAndUpdate(user._id, update).catch(() => {});
  }).catch(() => {});

  // Provisión de keypair Stellar custodial (fire-and-forget) — modelo custodial activo.
  // PSAV permite custodia (DS 5384, Cap. XI, Art. 4° literal l inciso 4). La secretKey
  // se cifra en AWS KMS (USER_KEYPAIR_KMS_KEY_ID); nunca se almacena en MongoDB ni logs.
  // Es fire-and-forget: si KMS falla, el KYC NO se bloquea (se reintenta vía custody/provision).
  provisionUserKeypair(user._id)
    .then(({ publicKey }) => {
      console.info(`[KYC Webhook] 🔑 Keypair custodial provisionado — userId: ${user._id} | publicKey: ${publicKey}`);
    })
    .catch(err => {
      console.error(`[KYC Webhook] ⚠️ Provisión de keypair falló — userId: ${user._id} | err: ${err.message}`);
    });

  console.info(
    `[KYC Webhook] ✅ APROBADO — userId: ${user._id} | email: ${user.email} | entity: ${user.legalEntity} | prevStatus: ${prevStatus} → approved`
  );
}

async function _rejectKyc(session, errorCode) {
  const user = await User.findOne({ stripeVerificationSessionId: session.id });

  if (!user) {
    console.warn(`[KYC Webhook] Usuario no encontrado para sessionId: ${session.id}`);
    return;
  }

  const prevStatus   = user.kycStatus;
  user.kycStatus     = 'rejected';
  user.kycRejectedAt = new Date();
  user.kycErrorCode  = errorCode;
  await user.save();
  invalidateUserCache(user._id); // forzar refresco del cache del middleware

  notify(user._id, {
    title: 'Verificación no completada',
    body:  'Tu verificación de identidad no pudo ser aprobada. Por favor intenta nuevamente o contacta soporte.',
    data:  { type: 'kyc_rejected', errorCode },
  }).catch(() => {});

  console.info(
    `[KYC Webhook] ❌ RECHAZADO — userId: ${user._id} | email: ${user.email} | code: ${errorCode} | prevStatus: ${prevStatus} → rejected`
  );
}
