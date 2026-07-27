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
 * Lookup de usuario: stripeVerificationSessionId guardado en kycController.
 */

import Stripe          from 'stripe';
import User             from '../models/User.js';
import { invalidateUserCache } from '../middlewares/authMiddleware.js';
import { notify }       from '../services/notifications.js';
import { screenUser }   from '../services/sanctionsService.js';
import { provisionUserKeypair } from '../services/custodyService.js';
import { isRealDocumentNumber } from '../utils/clientDocument.js';

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
          await _recoverKyc(session, errorCode);
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

  // Extracción de datos verificados (DOB, documento, dirección) — best-effort,
  // fire-and-forget. Enriquece/confirma lo que el usuario declaró en el form de
  // cumplimiento con la fuente autoritativa (Stripe). NUNCA bloquea la aprobación.
  _persistVerifiedOutputs(session, user._id).catch(() => {});

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

/**
 * Recupera los verified_outputs de la sesión de Stripe Identity y persiste los
 * datos autoritativos (fecha de nacimiento verificada, número de documento real
 * y, si falta, la dirección extraída del documento). Best-effort: tolera cualquier
 * variación del shape de la API y nunca lanza.
 */
async function _persistVerifiedOutputs(session, userId) {
  try {
    const full = await getStripe().identity.verificationSessions.retrieve(
      session.id, { expand: ['verified_outputs'] },
    );
    const vo = full?.verified_outputs;
    if (!vo) return;

    const $set = {};
    const current = await User.findById(userId).select('address identityDocument.number').lean();

    // Fecha de nacimiento verificada (fuente autoritativa).
    if (vo.dob && vo.dob.year) {
      $set.dateOfBirth = new Date(Date.UTC(vo.dob.year, (vo.dob.month ?? 1) - 1, vo.dob.day ?? 1));
    }
    // Número de documento: usar el de Stripe SOLO si el usuario no declaró uno real
    // en el KYC (no pisar el CI declarado). Reemplaza el placeholder 'PENDING_VERIFICATION'.
    if (
      typeof vo.id_number === 'string' && vo.id_number.trim() &&
      !isRealDocumentNumber(current?.identityDocument?.number)
    ) {
      $set['identityDocument.number'] = vo.id_number.trim();
    }
    // Dirección del documento — solo como respaldo si el usuario no cargó una.
    const hasAddr = current?.address && (current.address.street || current.address.city);
    if (!hasAddr && vo.address && (vo.address.line1 || vo.address.city)) {
      $set.address = {
        street:  [vo.address.line1, vo.address.line2].filter(Boolean).join(' ').trim(),
        city:    vo.address.city  ?? '',
        state:   vo.address.state ?? '',
        zip:     vo.address.postal_code ?? '',
        country: (vo.address.country ?? '').toUpperCase(),
      };
    }

    if (Object.keys($set).length > 0) {
      await User.updateOne({ _id: userId }, { $set });
      invalidateUserCache(userId);
      console.info('[KYC Webhook] verified_outputs persistidos:', { userId: userId?.toString(), fields: Object.keys($set) });
    }
  } catch (err) {
    console.warn('[KYC Webhook] No se pudieron extraer verified_outputs:', err.message);
  }
}

/**
 * _recoverKyc — maneja un `requires_input` recuperable (abandoned, consent_declined,
 * problemas de cámara/dispositivo, etc.). El usuario empezó pero no completó la
 * biometría. Lo devolvemos a 'pending' para que el frontend muestre de nuevo el
 * botón de verificación y pueda re-lanzar /kyc/session. Sin esto el usuario queda
 * atascado en 'in_review' con polling infinito.
 */
async function _recoverKyc(session, errorCode) {
  const user = await User.findOne({ stripeVerificationSessionId: session.id });

  if (!user) {
    console.warn(`[KYC Webhook] Usuario no encontrado para sessionId: ${session.id}`);
    return;
  }

  // Si ya está resuelto (approved/rejected) o ya en pending, no tocar.
  if (user.kycStatus !== 'in_review') {
    console.info(`[KYC Webhook] Corrección recuperable ignorada — userId: ${user._id} | kycStatus actual: ${user.kycStatus} | code: ${errorCode ?? 'unknown'}`);
    return;
  }

  const prevStatus = user.kycStatus;
  user.kycStatus   = 'pending';
  await user.save();
  invalidateUserCache(user._id);

  notify(user._id, {
    title: 'Verificación incompleta',
    body:  'No terminaste tu verificación de identidad. Puedes reintentarla cuando quieras desde la app.',
    data:  { type: 'kyc_recoverable', errorCode: errorCode ?? null },
  }).catch(() => {});

  console.info(
    `[KYC Webhook] ↩️ RECUPERABLE — userId: ${user._id} | email: ${user.email} | code: ${errorCode ?? 'unknown'} | prevStatus: ${prevStatus} → pending`
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
