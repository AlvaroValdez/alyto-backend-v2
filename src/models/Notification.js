/**
 * Notification.js — Modelo de notificaciones persistentes.
 *
 * Almacena todas las notificaciones enviadas a cada usuario para
 * alimentar el centro de notificaciones (historial, badge, mark-as-read).
 *
 * TTL de 90 días — MongoDB elimina documentos automáticamente.
 */

import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },

    type: {
      type:     String,
      required: true,
      enum: [
        'payin_confirmed',
        'payment_completed',
        'payment_failed',
        'payout_sent',
        'deposit_confirmed',
        'withdrawal_requested',
        'wallet_frozen',
        'wallet_unfrozen',
        'p2p_received',
        'conversion_confirmed',
        'conversion_rejected',
        'general',
      ],
    },

    title: { type: String, required: true },
    body:  { type: String, required: true },
    data:  { type: mongoose.Schema.Types.Mixed, default: {} },

    read:   { type: Boolean, default: false },
    readAt: { type: Date,    default: null  },
  },
  { timestamps: true },
);

// Consulta principal: notificaciones del usuario, no leídas primero, más recientes primero
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

// TTL — auto-eliminar después de 90 días
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 });

export default mongoose.model('Notification', notificationSchema);
