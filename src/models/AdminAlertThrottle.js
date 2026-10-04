/**
 * AdminAlertThrottle.js — Antirrepetición de alertas admin, persistente.
 *
 * Guarda, por clave de alerta, cuándo se envió la última vez. Vive en MongoDB y
 * no en memoria del proceso a propósito: el cooldown en memoria de
 * `anchorAdminAlerts` se reseteaba en cada recreación de contenedor, y el
 * 2026-10-01 hubo tres deploys en un día, así que una alerta con cooldown de 6
 * horas salió 8 veces.
 *
 * El TTL limpia solo: cada documento expira un poco después de su propio
 * cooldown, así que la colección no crece sin control ni hace falta purgarla.
 */

import mongoose from 'mongoose';

const adminAlertThrottleSchema = new mongoose.Schema(
  {
    /** Identifica la alerta. Incluye el sujeto cuando aplica, p. ej. `payout-corridor-missing:ALY-C-...`. */
    key: {
      type:     String,
      required: true,
      unique:   true,
      index:    true,
    },
    /** Momento del último envío efectivo. */
    lastSentAt: {
      type:     Date,
      required: true,
    },
    /** Cuántas veces se envió realmente esta alerta. */
    enviadas: {
      type:    Number,
      default: 1,
    },
    /**
     * Cuántas se silenciaron por estar dentro del cooldown. Es el dato que
     * permite notar que algo está reintentando en bucle sin que el email lo
     * delate: una alerta con 2 envíos y 300 silenciadas señala un problema
     * distinto al que describe su asunto.
     */
    suprimidas: {
      type:    Number,
      default: 0,
    },
    /** Momento a partir del cual el documento puede borrarse (índice TTL). */
    expiresAt: {
      type:     Date,
      required: true,
    },
  },
  { timestamps: true, collection: 'admin_alert_throttle' },
);

// TTL: MongoDB borra el documento cuando se pasa `expiresAt`.
adminAlertThrottleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('AdminAlertThrottle', adminAlertThrottleSchema);
