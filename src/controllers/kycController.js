/**
 * kycController.js — Endpoints de estado KYC del usuario
 *
 * GET  /api/v1/kyc/session         → Crea VerificationSession de Stripe Identity
 * GET  /api/v1/kyc/status          → Devuelve el kycStatus actual del usuario autenticado
 * POST /api/v1/kyc/session/restart → Cancela la sesión en curso y habilita el reintento
 * POST /api/v1/kyc/telemetry       → Hitos del intento reportados por el cliente
 */

import Stripe          from 'stripe';
import User             from '../models/User.js';
import { invalidateUserCache } from '../middlewares/authMiddleware.js';
import { screenUser }   from '../services/sanctionsService.js';
import { readDocumentNumber } from '../utils/clientDocument.js';
import { ensureDek, isPiiEncryptionEnabled } from '../services/piiCrypto.js';
import { approveKycFromSession } from '../webhooks/stripeWebhook.js';
import { areSimulatorsAllowed } from '../utils/environment.js';
import { resolveKycFromStripe } from '../services/kycSessionResolver.js';
import { openKycAttempt, markKycAttempt, closeKycAttempt, normalizePlatform } from '../services/kycTelemetry.js';

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

    // Bitácora del intento. Sin esto, de un KYC que falla en la página alojada de
    // Stripe no queda rastro de desde dónde se lanzó ni de si llegó a cargar.
    await openKycAttempt({
      user,
      sessionId: session.id,
      platform:  normalizePlatform(req.query?.platform),
      req,
    });

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
    //
    // ⚠️ El criterio vive en [kycSessionResolver], no acá: el barrido periódico
    // tiene que aplicar exactamente el mismo, y una sesión 'requires_input' sin
    // error es ambigua (puede ser una captura en curso o una página que nunca
    // cargó), así que una divergencia entre ambos cambia el estado del usuario.
    if (user.kycStatus === 'in_review' && user.stripeVerificationSessionId) {
      try {
        const resolved = await resolveKycFromStripe(user);
        return res.json({
          kycStatus:     resolved.kycStatus,
          kycApprovedAt: resolved.kycApprovedAt ?? null,
        });
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

// ─── restartKycSession ───────────────────────────────────────────────────────

/**
 * POST /api/v1/kyc/session/restart
 * Requiere JWT + email verificado + info de cumplimiento completa.
 *
 * Cancela la sesión de Stripe en curso y devuelve al usuario a 'pending' para
 * que pueda lanzar una nueva.
 *
 * Por qué existe: `createKycSession` marca 'in_review' en cuanto crea la sesión,
 * antes de que el usuario haya hecho nada. Si la página alojada de Stripe falla
 * al cargar —pasó el 2026-10-02 con un usuario en datos móviles— quedaba viendo
 * "verificando tu identidad" sin ninguna salida hasta que la sesión envejeciera
 * los `KYC_SESSION_STALE_MIN` minutos. El reintento no se puede deducir del
 * estado de Stripe (una sesión recién creada y una que nunca cargó se ven
 * idénticas), así que tiene que ser una acción explícita del usuario.
 *
 * @returns {{ kycStatus: string, canceledSessionId: string|null }}
 */
export async function restartKycSession(req, res) {
  try {
    const user   = req.user;
    const userId = user._id.toString();

    if (user.kycStatus === 'approved') {
      return res.status(409).json({
        error:     'Tu identidad ya está verificada.',
        kycStatus: 'approved',
      });
    }

    // ⚠️ `protect` NO incluye stripeVerificationSessionId en su select, así que
    // leerlo de req.user devolvería undefined: nos saltaríamos la cancelación en
    // Stripe y dejaríamos la sesión viva compitiendo con la siguiente.
    const actual = await User.findById(userId).select('stripeVerificationSessionId').lean();
    const sessionId = actual?.stripeVerificationSessionId ?? null;
    let canceledSessionId = null;

    if (sessionId) {
      try {
        const session = await getStripe().identity.verificationSessions.retrieve(sessionId);

        // Carrera real: el usuario terminó en Stripe y pulsó reintentar antes de
        // que el webhook llegara. Cancelar acá tiraría una verificación buena.
        if (session.status === 'verified') {
          await approveKycFromSession(session);
          console.info(`[KYC Restart] Sesión ya verificada — se aprueba en vez de reiniciar — userId: ${userId}`);
          return res.json({ kycStatus: 'approved', canceledSessionId: null });
        }

        // 'processing': el usuario YA envió documento y selfie, y Stripe está
        // resolviendo. Reiniciar acá le haría repetir la captura sin motivo.
        if (session.status === 'processing') {
          return res.status(409).json({
            error:     'Tu verificación se está procesando. Espera unos segundos antes de reintentar.',
            kycStatus: 'in_review',
          });
        }

        // Stripe solo admite cancelar en 'requires_input'. Cancelar deja la
        // sesión vieja inerte para el webhook y evita que dos sesiones del mismo
        // usuario compitan por resolver su estado.
        if (session.status === 'requires_input') {
          await getStripe().identity.verificationSessions.cancel(sessionId);
          canceledSessionId = sessionId;
        }
      } catch (stripeErr) {
        // Que Stripe no responda no puede dejar al usuario atrapado: seguimos
        // adelante con el reinicio local. La sesión huérfana la cierra el barrido.
        console.warn(`[KYC Restart] No se pudo cancelar en Stripe: ${stripeErr.message}`);
      }

      await markKycAttempt(sessionId, { restartedAt: new Date() });
      await closeKycAttempt(sessionId, { outcome: 'restarted', stripeStatus: 'canceled' });
    }

    await User.findByIdAndUpdate(userId, {
      kycStatus:                   'pending',
      stripeVerificationSessionId: null,
    });
    invalidateUserCache(userId);

    console.info(`[KYC Restart] Reintento habilitado — userId: ${userId} | sesión cancelada: ${canceledSessionId ?? 'ninguna'}`);
    return res.json({ kycStatus: 'pending', canceledSessionId });

  } catch (err) {
    console.error('[KYC] Error reiniciando la verificación:', err.message);
    return res.status(500).json({ error: 'No se pudo reiniciar la verificación. Intenta nuevamente.' });
  }
}

// ─── recordKycClientEvent ────────────────────────────────────────────────────

/**
 * POST /api/v1/kyc/telemetry
 * Body: { event: 'returned' }
 *
 * Único hito que el servidor no puede observar por su cuenta: que el navegador
 * volvió del alojado de Stripe. Un intento sin `returnedAt` y con `restartedAt`
 * es la firma de una página de Stripe que nunca cargó; con `returnedAt`, de un
 * usuario que la vio y la abandonó. Son dos problemas distintos.
 */
const CLIENT_EVENTS = {
  returned: () => ({ returnedAt: new Date() }),
};

export async function recordKycClientEvent(req, res) {
  try {
    const build = CLIENT_EVENTS[req.body?.event];
    if (!build) {
      return res.status(400).json({ error: 'Evento desconocido.' });
    }

    // Mismo motivo que en restartKycSession: el campo no viene en req.user.
    const actual = await User.findById(req.user._id).select('stripeVerificationSessionId').lean();
    if (actual?.stripeVerificationSessionId) {
      await markKycAttempt(actual.stripeVerificationSessionId, build());
    }

    return res.status(204).end();
  } catch (err) {
    // Telemetría: nunca puede hacer fallar al cliente.
    console.warn('[KYC Telemetría] Evento de cliente descartado:', err.message);
    return res.status(204).end();
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
 * Aprueba el KYC de un usuario sin pasar por Stripe Identity.
 * Útil para testing de flujos post-KYC sin depender del webhook.
 *
 * Doble candado — mismo criterio que las rutas /dev de server.js:
 *   1. ALYTO_ENABLE_DEV_ROUTES === '1'
 *   2. entorno donde se permiten simuladores (nunca el VPS de producción)
 *
 * ⚠️ Hasta 2026-08-15 el docstring decía "Solo disponible en NODE_ENV !==
 * 'production'" pero el código NO lo verificaba: el único gate era el flag.
 * Con el flag encendido en el VPS, esto aprobaba el KYC de cualquier userId
 * sin biometría, sin motivo y sin AdminAuditLog. La discrepancia doc/código es
 * lo peligroso: hace que alguien lo crea seguro al leerlo.
 *
 * Body: { userId: string }
 * Respuesta 200: { message, user: { id, email, kycStatus } }
 */
export async function approveKycTest(req, res) {
  if (process.env.ALYTO_ENABLE_DEV_ROUTES !== '1' || !areSimulatorsAllowed()) {
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
    const fullUser = await User.findById(userId)
      .select('firstName lastName identityDocument +identityDocument.numberCiphertext').lean();
    if (fullUser) {
      if (isPiiEncryptionEnabled()) { try { await ensureDek(); } catch { /* cae a solo-nombre */ } }
      let ci = null;
      try { ci = readDocumentNumber(fullUser); } catch { ci = null; }
      runSanctionsScreening(userId, fullUser.firstName, fullUser.lastName, ci);
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
