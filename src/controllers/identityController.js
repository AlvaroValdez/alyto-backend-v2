/**
 * identityController.js — Verificación Biométrica con Stripe Identity
 *
 * Flujo:
 *  1. El usuario autenticado solicita una sesión de verificación (POST /identity/verify)
 *  2. Se crea una VerificationSession en Stripe con document + selfie biométrica
 *  3. El session_id se persiste en el usuario; la client_secret se devuelve al frontend
 *  4. El frontend usa loadStripe().verifyIdentity(clientSecret) para abrir el modal nativo
 *  5. Stripe notifica el resultado vía webhook → stripeWebhook.js actualiza kycStatus
 */

import Stripe from 'stripe';
import User   from '../models/User.js';

// Inicialización lazy — se resuelve en tiempo de ejecución para que
// process.env esté cargado por dotenv antes de instanciar el cliente
let _stripe = null;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// ─── createVerificationSession ────────────────────────────────────────────────

/**
 * POST /api/v1/identity/verify
 * Protegido por middleware protect() — req.user está disponible.
 *
 * Crea una VerificationSession biométrica en Stripe Identity con:
 *   - Documento de identidad (captura en vivo, sin capturas subidas manualmente)
 *   - Selfie biométrica con coincidencia facial obligatoria
 *
 * Guarda el verification_session_id en el usuario (para lookup en el webhook)
 * y devuelve la client_secret al frontend para abrir el modal de Stripe.
 *
 * @returns {{ clientSecret: string, sessionId: string }}
 */
export async function createVerificationSession(req, res) {
  try {
    const user   = req.user;
    const userId = user._id.toString();

    // Crear sesión en Stripe — configurada para biometría completa
    const session = await getStripe().identity.verificationSessions.create({
      type: 'document',
      options: {
        document: {
          // Exige captura de imagen en vivo (cámara) — prohíbe uploads de archivos
          require_live_capture: true,
          // Selfie biométrica con coincidencia facial obligatoria
          require_matching_selfie: true,
          // Permitir múltiples tipos de documento según la entidad del usuario
          allowed_types: ['driving_license', 'id_card', 'passport'],
        },
      },
      // Metadata para lookup en webhook y auditoría
      metadata: {
        userId:      userId,
        legalEntity: user.legalEntity,
        email:       user.email,
      },
    });

    // Persistir el ID de sesión en el documento del usuario
    // kycStatus → 'in_review' hasta que el webhook confirme el resultado
    await User.findByIdAndUpdate(userId, {
      stripeVerificationSessionId: session.id,
      kycStatus:                   'in_review',
      kycProvider:                 'stripe_identity',
    });

    console.info(
      `[Identity] Sesión creada — userId: ${userId} | sessionId: ${session.id} | entity: ${user.legalEntity}`
    );

    return res.status(200).json({
      clientSecret: session.client_secret,
      sessionId:    session.id,
    });

  } catch (error) {
    console.error('[Identity] Error al crear sesión de verificación:', error.message);
    return res.status(500).json({
      error: 'No se pudo iniciar la sesión de verificación. Intenta nuevamente.',
    });
  }
}
