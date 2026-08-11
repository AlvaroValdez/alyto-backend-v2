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
 *       devuelven al usuario a 'pending' para que reintente.
 *
 *   identity.verification_session.canceled
 *     → Sesión cancelada — se devuelve al usuario a 'pending' (reintento).
 *
 * Errores al procesar un evento responden 500 → Stripe reintenta con backoff.
 *
 * Lookup de usuario: stripeVerificationSessionId guardado en kycController.
 */

import Stripe          from 'stripe';
import User             from '../models/User.js';
import { invalidateUserCache } from '../middlewares/authMiddleware.js';
import { notify }       from '../services/notifications.js';
import { screenUser }   from '../services/sanctionsService.js';
import { provisionUserKeypair } from '../services/custodyService.js';
import { isRealDocumentNumber, readDocumentNumber, hasRealDocumentNumber, applyDocumentNumberToSet } from '../utils/clientDocument.js';
import { ensureDek, isPiiEncryptionEnabled } from '../services/piiCrypto.js';

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
          `[KYC Webhook] ${event.type} | sessionId: ${session.id} | La sesión fue cancelada`
        );
        // Sin esto el usuario queda atascado en 'in_review' (el polling tampoco
        // resuelve 'canceled') sin botón de reintento.
        await _recoverKyc(session, 'canceled');
        break;
      }

      default:
        // Eventos no gestionados — loguear y responder 200 para evitar reintentos
        console.info(`[Stripe Webhook] Evento no procesado: ${event.type}`);
    }
  } catch (err) {
    // Responder 500 para que Stripe REINTENTE el evento (backoff hasta 3 días).
    // Un fallo transitorio (DB caída) ya no pierde la aprobación/rechazo — antes
    // se respondía 200 y el evento se descartaba para siempre.
    console.error('[Stripe Webhook] Error procesando evento:', err.message);
    return res.status(500).json({ error: 'Event processing failed' });
  }

  return res.status(200).json({ received: true });
}

// ─── Helpers privados ─────────────────────────────────────────────────────────

/**
 * Busca al usuario de una sesión: primero por stripeVerificationSessionId
 * (camino normal) y, si no matchea, por session.metadata.userId — cubre el caso
 * de una sesión pisada por un reintento posterior o un write fallido tras crear
 * la sesión. Devuelve { user, isCurrentSession }.
 */
async function _findUserForSession(session) {
  let user = await User.findOne({ stripeVerificationSessionId: session.id });
  if (user) return { user, isCurrentSession: true };

  const metaUserId = session.metadata?.userId;
  if (metaUserId) {
    user = await User.findById(metaUserId).catch(() => null);
    if (user) {
      console.warn(`[KYC Webhook] Sesión ${session.id} no es la vigente del usuario ${user._id} (actual: ${user.stripeVerificationSessionId ?? 'ninguna'}) — recuperado vía metadata.userId`);
      return { user, isCurrentSession: false };
    }
  }
  return { user: null, isCurrentSession: false };
}

/**
 * Aplica TODOS los efectos de una aprobación KYC a partir de una sesión de
 * Stripe Identity: kycStatus, verified_outputs, screening AML, notificación y
 * provisión del keypair custodial. Exportada para que el fallback por polling
 * (kycController.getKycStatus) apruebe con exactamente los mismos efectos que
 * el webhook.
 */
export async function approveKycFromSession(session) {
  return _approveKyc(session);
}

async function _approveKyc(session) {
  const { user } = await _findUserForSession(session);

  if (!user) {
    console.warn(`[KYC Webhook] Usuario no encontrado para sessionId: ${session.id} — ¿Se guardó stripeVerificationSessionId en la sesión?`);
    return;
  }

  // Una identidad verificada por Stripe aprueba SIEMPRE, aunque la sesión ya no
  // sea la vigente (p.ej. el usuario relanzó otra sesión mientras esta procesaba).

  const prevStatus    = user.kycStatus;
  user.kycStatus      = 'approved';
  user.kycApprovedAt  = new Date();
  user.kycProvider    = 'stripe_identity';
  await user.save();
  invalidateUserCache(user._id); // forzar refresco del cache del middleware

  // Extracción de datos verificados (DOB, documento, dirección, nombres) —
  // best-effort, y LUEGO screening AML con los datos más frescos: los nombres
  // verificados por Stripe son la fuente autoritativa para sanciones, no lo
  // declarado en el registro (que puede ser el default 'Usuario Alyto').
  // La cadena completa es fire-and-forget: NUNCA bloquea la aprobación.
  _persistVerifiedOutputs(session, user._id)
    .catch(() => null)
    .then(vo => _screenAfterApproval(user, vo))
    .catch(() => {});

  notify(user._id, {
    title: '¡Identidad verificada! ✓',
    body:  'Tu identidad fue verificada exitosamente. Ya puedes empezar a usar Alyto.',
    data:  { type: 'kyc_approved' },
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
 * Screening AML post-aprobación (Fase 28, exigencia ASFI) — corre DESPUÉS de
 * persistir los verified_outputs, con los datos autoritativos de Stripe si
 * están (nombres verificados, documento actualizado). Nunca lanza.
 */
async function _screenAfterApproval(user, vo) {
  try {
    const fresh = await User.findById(user._id)
      .select('firstName lastName identityDocument.number +identityDocument.numberCiphertext').lean().catch(() => null);

    if (isPiiEncryptionEnabled()) { try { await ensureDek(); } catch { /* screening cae a solo-nombre */ } }
    let documentNumber = null;
    try { documentNumber = readDocumentNumber(fresh) ?? readDocumentNumber(user); } catch { documentNumber = null; }

    const result = await screenUser({
      firstName:      (typeof vo?.first_name === 'string' && vo.first_name.trim()) || fresh?.firstName || user.firstName,
      lastName:       (typeof vo?.last_name === 'string' && vo.last_name.trim())  || fresh?.lastName  || user.lastName,
      documentNumber,
    });

    const update = { sanctionsScreenedAt: result.screenedAt, sanctionsFlag: !result.isClean };
    if (!result.isClean) {
      console.warn('[Sanctions KYC Webhook] ⚠️ Posible hit:', {
        userId: user._id?.toString(),
        hits:   result.hits.map(h => `${h.entryId} (${h.listSource})`),
      });
    }
    await User.findByIdAndUpdate(user._id, update);
  } catch (err) {
    console.warn('[Sanctions KYC Webhook] Screening post-aprobación falló:', err.message);
  }
}

// Defaults de nombre del registro (authController) — si siguen intactos al
// aprobar, se reemplazan por los nombres verificados del documento.
const REGISTER_FIRSTNAME_PLACEHOLDER = 'Usuario';
const REGISTER_LASTNAME_PLACEHOLDER  = 'Alyto';

/**
 * Recupera los verified_outputs de la sesión de Stripe Identity y persiste los
 * datos autoritativos (fecha de nacimiento verificada, número de documento real,
 * nombres del documento si el perfil sigue con placeholders y, si falta, la
 * dirección extraída del documento). Best-effort: tolera cualquier variación
 * del shape de la API y nunca lanza. Devuelve los verified_outputs (o null)
 * para que el screening AML posterior use los datos autoritativos.
 */
async function _persistVerifiedOutputs(session, userId) {
  try {
    const full = await getStripe().identity.verificationSessions.retrieve(
      session.id, { expand: ['verified_outputs'] },
    );
    const vo = full?.verified_outputs;
    if (!vo) return null;

    const $set = {};
    const current = await User.findById(userId)
      .select('address identityDocument.number +identityDocument.numberCiphertext firstName lastName').lean();

    // Fecha de nacimiento verificada (fuente autoritativa).
    if (vo.dob && vo.dob.year) {
      $set.dateOfBirth = new Date(Date.UTC(vo.dob.year, (vo.dob.month ?? 1) - 1, vo.dob.day ?? 1));
    }
    // Nombres verificados del documento — solo si el perfil conserva los
    // defaults del registro (no pisar lo que el usuario declaró a propósito).
    if (typeof vo.first_name === 'string' && vo.first_name.trim()
        && current?.firstName === REGISTER_FIRSTNAME_PLACEHOLDER) {
      $set.firstName = vo.first_name.trim();
    }
    if (typeof vo.last_name === 'string' && vo.last_name.trim()
        && current?.lastName === REGISTER_LASTNAME_PLACEHOLDER) {
      $set.lastName = vo.last_name.trim();
    }
    // Número de documento: usar el de Stripe SOLO si el usuario no declaró uno real
    // en el KYC (no pisar el CI declarado). Reemplaza el placeholder 'PENDING_VERIFICATION'.
    // Se cifra (numberCiphertext) cuando PII_ENCRYPTION_ENABLED está activo.
    if (
      typeof vo.id_number === 'string' && vo.id_number.trim() &&
      !hasRealDocumentNumber(current)
    ) {
      await applyDocumentNumberToSet($set, userId, vo.id_number.trim());
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
    return vo;
  } catch (err) {
    console.warn('[KYC Webhook] No se pudieron extraer verified_outputs:', err.message);
    return null;
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
  const { user, isCurrentSession } = await _findUserForSession(session);

  if (!user) {
    console.warn(`[KYC Webhook] Usuario no encontrado para sessionId: ${session.id}`);
    return;
  }

  // Una sesión vieja (pisada por un reintento) no debe tocar el estado del
  // intento vigente.
  if (!isCurrentSession) {
    console.info(`[KYC Webhook] Corrección recuperable de sesión no vigente ignorada — userId: ${user._id} | sessionId: ${session.id}`);
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
  const { user, isCurrentSession } = await _findUserForSession(session);

  if (!user) {
    console.warn(`[KYC Webhook] Usuario no encontrado para sessionId: ${session.id}`);
    return;
  }

  // Un rechazo de una sesión no vigente, o llegado tarde, nunca degrada una
  // identidad ya aprobada (p.ej. el usuario reintentó y la nueva sesión verificó).
  if (!isCurrentSession || user.kycStatus === 'approved') {
    console.info(`[KYC Webhook] Rechazo ignorado — userId: ${user._id} | sessionId: ${session.id} | vigente: ${isCurrentSession} | kycStatus: ${user.kycStatus}`);
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
