/**
 * KycAttempt.js — Bitácora de intentos de verificación de identidad.
 *
 * Hasta ahora, de un KYC que fallaba solo quedaba una línea en la bitácora de
 * aplicación ("Session creada") y el estado final en `User`. Cuando el 2026-10-02
 * un usuario reportó que la página de Stripe mostraba "Se ha producido un error
 * inesperado", no había forma de saber desde el sistema si había llegado siquiera
 * a cargar esa página: la sesión en Stripe se veía igual que la de alguien que
 * todavía estaba sacando la foto de su documento.
 *
 * Esta colección registra el intento completo, no solo su desenlace. El dato que
 * resuelve esa ambigüedad es la combinación de dos campos:
 *
 *   returnedAt = null  +  restartedAt presente
 *     → el navegador nunca volvió del alojado de Stripe y el usuario pidió
 *       reintentar. La página de Stripe falló antes de que pudiera enviar nada.
 *
 *   returnedAt presente  +  outcome 'abandoned'
 *     → la página cargó y el usuario la abandonó. Es un problema de producto,
 *       no de disponibilidad.
 *
 * Sin retención por TTL, a diferencia de [JobRun]: esto no es telemetría
 * operativa sino parte del rastro de la debida diligencia del cliente.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

const kycAttemptSchema = new Schema(
  {
    userId: {
      type:     Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },
    /** Copia del email al momento del intento — sobrevive a un cambio posterior. */
    email:       { type: String, default: null },
    legalEntity: { type: String, default: null },

    /** Id de la VerificationSession de Stripe. Clave natural del intento. */
    sessionId: {
      type:     String,
      required: true,
      unique:   true,
    },

    // ── Desde dónde se lanzó ────────────────────────────────────────────────
    /**
     * Rama del cliente que abrió la verificación. Las tres se comportan distinto
     * y fallan distinto: 'native' abre una pestaña del sistema, 'mobile-web'
     * navega la página entera, 'desktop' usa el modal del SDK.
     */
    platform: {
      type:    String,
      enum:    ['native', 'mobile-web', 'desktop', 'unknown'],
      default: 'unknown',
    },
    userAgent: { type: String, default: null },
    ip:        { type: String, default: null },

    // ── Hitos del intento ───────────────────────────────────────────────────
    /** El navegador volvió a /kyc/return: prueba de que el alojado de Stripe cargó. */
    returnedAt:  { type: Date, default: null },
    /** El usuario pidió empezar de nuevo desde la pantalla de "en proceso". */
    restartedAt: { type: Date, default: null },

    // ── Desenlace ───────────────────────────────────────────────────────────
    outcome: {
      type:    String,
      enum:    ['open', 'approved', 'rejected', 'abandoned', 'restarted'],
      default: 'open',
      index:   true,
    },
    outcomeAt:       { type: Date,   default: null },
    /** Último `status` observado en Stripe (verified, requires_input, canceled…). */
    stripeStatus:    { type: String, default: null },
    /** `last_error.code` de Stripe, si lo hubo (document_expired, abandoned…). */
    stripeErrorCode: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: 'kyc_attempts',
  },
);

// Historial por usuario, del más reciente al más antiguo.
kycAttemptSchema.index({ userId: 1, createdAt: -1 });
// Barrido de intentos sin cerrar.
kycAttemptSchema.index({ outcome: 1, createdAt: -1 });

const KycAttempt = mongoose.model('KycAttempt', kycAttemptSchema);

export default KycAttempt;
