/**
 * notifications.js — Firebase Cloud Messaging (FCM) para notificaciones push.
 *
 * Envía notificaciones a todos los dispositivos registrados de un usuario.
 * Tokens expirados o inválidos se eliminan automáticamente de MongoDB.
 *
 * Uso:
 *   import { sendPushNotification, NOTIFICATIONS } from './notifications.js'
 *   await sendPushNotification(userId, NOTIFICATIONS.payinConfirmed(50000, 'CLP'))
 */

import User from '../models/User.js';
import Notification from '../models/Notification.js';

// ─── Inicialización lazy (dinámica) de Firebase ───────────────────────────────
// Se usa import() dinámico para que un fallo de Firebase NO bloquee el arranque
// del servidor ni impida el envío de emails transaccionales.

let firebaseAdmin = null;

const initFirebase = async () => {
  try {
    if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      const admin = (await import('firebase-admin')).default;
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          }),
        });
      }
      firebaseAdmin = admin;
      console.log('[FCM] Firebase inicializado ✅');
    } else {
      console.warn('[FCM] Variables Firebase no configuradas — push deshabilitado');
    }
  } catch (error) {
    console.warn('[FCM] Firebase no disponible:', error.message);
    firebaseAdmin = null;
  }
};

initFirebase();

// ─── Tokens inválidos (códigos FCM que indican expiración o registro borrado) ─

const INVALID_TOKEN_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

// ─── sendPushNotification ─────────────────────────────────────────────────────

/**
 * Envía una notificación push a todos los dispositivos del usuario.
 * Limpia tokens expirados automáticamente.
 * Falla silenciosamente si el usuario no tiene tokens o FCM no está configurado.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {{ title: string, body: string, data?: Record<string,string> }} notification
 * @returns {Promise<void>}
 */
export async function sendPushNotification(userId, notification) {
  if (!firebaseAdmin) {
    console.log('[FCM] Push deshabilitado — omitiendo para userId:', userId?.toString());
    return null;
  }

  // ── 1. Buscar usuario y sus tokens FCM ───────────────────────────────────
  let user;
  try {
    user = await User.findById(userId).select('fcmTokens').lean();
  } catch (err) {
    console.error('[Alyto FCM] Error buscando usuario para notificación:', {
      userId: userId?.toString(),
      error:  err.message,
    });
    return;
  }

  if (!user?.fcmTokens?.length) return; // Sin dispositivos registrados — salida silenciosa

  // ── 2. Enviar a cada token en paralelo ───────────────────────────────────
  const staleTokens = [];

  const results = await Promise.allSettled(
    user.fcmTokens.map(async (fcmToken) => {
      const message = {
        token: fcmToken,
        notification: {
          title: notification.title,
          body:  notification.body,
        },
        // data debe ser Record<string, string> — convertir todos los valores
        data: Object.fromEntries(
          Object.entries(notification.data ?? {}).map(([k, v]) => [k, String(v)]),
        ),
        android: {
          priority: 'high',
          notification: {
            sound:     'default',
            channelId: 'payments',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      try {
        await firebaseAdmin.messaging().send(message);
        return { token: fcmToken, ok: true };
      } catch (err) {
        const errorCode = err.code ?? err.errorInfo?.code ?? '';
        if (INVALID_TOKEN_ERRORS.has(errorCode)) {
          staleTokens.push(fcmToken);
          return { token: fcmToken, ok: false, stale: true };
        }
        // Error transitorio (red, cuota, etc.) — no eliminar token
        return { token: fcmToken, ok: false, error: err.message };
      }
    }),
  );

  // ── 3. Loguear resultado ─────────────────────────────────────────────────
  const successful = results.filter(r => r.status === 'fulfilled' && r.value?.ok).length;
  const failed     = results.length - successful;

  console.info('[Alyto FCM] Notificación enviada.', {
    userId:      userId?.toString(),
    type:        notification.data?.type ?? 'unknown',
    total:       results.length,
    successful,
    failed,
    staleTokens: staleTokens.length,
  });

  // ── 4. Limpiar tokens expirados de MongoDB ───────────────────────────────
  if (staleTokens.length > 0) {
    try {
      await User.updateOne(
        { _id: userId },
        { $pull: { fcmTokens: { $in: staleTokens } } },
      );
      console.info('[Alyto FCM] Tokens expirados eliminados.', {
        userId: userId?.toString(),
        count:  staleTokens.length,
      });
    } catch (err) {
      console.error('[Alyto FCM] Error eliminando tokens expirados:', {
        userId: userId?.toString(),
        error:  err.message,
      });
    }
  }
}

// ─── notify() — Persiste + Push en un solo paso ──────────────────────────────

/**
 * Persiste la notificación en MongoDB y envía push vía FCM.
 * Nunca lanza excepción — ambos pasos son fire-and-forget.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {{ title: string, body: string, data?: Record<string,string> }} notification
 */
export async function notify(userId, notification) {
  // 1. Persistir en MongoDB
  try {
    await Notification.create({
      userId,
      type:  notification.data?.type ?? 'general',
      title: notification.title,
      body:  notification.body,
      data:  notification.data ?? {},
    });
  } catch (err) {
    console.error('[Alyto Notify] Error persistiendo notificación:', {
      userId: userId?.toString(),
      type:   notification.data?.type,
      error:  err.message,
    });
  }

  // 2. Enviar push FCM (existente, ya fire-and-forget)
  sendPushNotification(userId, notification).catch(() => {});
}

// ─── Plantillas de notificaciones predefinidas ────────────────────────────────

export const NOTIFICATIONS = {

  /**
   * Payin recibido — el usuario completó el pago y está en proceso.
   * @param {number} amount
   * @param {string} currency  ISO 4217 (ej. 'CLP')
   */
  payinConfirmed(amount, currency) {
    return {
      title: '💰 Pago recibido',
      body:  `Recibimos tu pago de ${Number(amount).toLocaleString('es-CL')} ${currency}. Tu transferencia está en camino.`,
      data:  { type: 'payin_confirmed' },
    };
  },

  /**
   * Transferencia completada — el beneficiario recibió los fondos.
   * @param {number} amount
   * @param {string} currency
   * @param {number} destinationAmount
   * @param {string} destinationCurrency
   */
  paymentCompleted(amount, currency, destinationAmount, destinationCurrency) {
    return {
      title: '¡Dinero entregado! ✓',
      body:  `Tu transferencia fue completada. El beneficiario recibió ${Number(destinationAmount).toLocaleString('es-CL')} ${destinationCurrency}.`,
      data:  { type: 'payment_completed' },
    };
  },

  /**
   * Transferencia fallida — el pago no pudo procesarse.
   * @param {number} amount
   * @param {string} currency
   */
  paymentFailed(amount, currency) {
    return {
      title: 'Transferencia no completada',
      body:  `Tu transferencia de ${Number(amount).toLocaleString('es-CL')} ${currency} no pudo completarse. Por favor contáctanos para resolver esto.`,
      data:  { type: 'payment_failed' },
    };
  },

  /**
   * Payout enviado al banco destino — acreditación en hasta 1 día hábil.
   * @param {string} destinationCountry  ISO 3166-1 alpha-2 (ej. 'BO', 'CO')
   */
  payoutSent(destinationCountry) {
    return {
      title: 'Transferencia en camino 🚀',
      body:  `Enviamos el pago al banco de ${destinationCountry}. La acreditación puede tomar hasta 1 día hábil.`,
      data:  { type: 'payout_sent' },
    };
  },

  // ── Wallet BOB ────────────────────────────────────────────────────────────

  depositConfirmed(amount) {
    return {
      title: 'Depósito acreditado ✓',
      body:  `Tu depósito de Bs. ${Number(amount).toFixed(2)} fue acreditado en tu wallet.`,
      data:  { type: 'deposit_confirmed' },
    };
  },

  withdrawalRequested(amount) {
    return {
      title: 'Retiro en proceso',
      body:  `Tu solicitud de retiro de Bs. ${Number(amount).toFixed(2)} fue recibida. Procesaremos en 1-2 días hábiles.`,
      data:  { type: 'withdrawal_requested' },
    };
  },

  walletFrozen() {
    return {
      title: 'Wallet suspendida',
      body:  'Tu wallet ha sido suspendida temporalmente por razones regulatorias. Contacta a soporte para más información.',
      data:  { type: 'wallet_frozen' },
    };
  },

  walletUnfrozen(balance) {
    return {
      title: 'Wallet reactivada ✓',
      body:  `Tu wallet fue reactivada. Saldo disponible: Bs. ${Number(balance).toFixed(2)}.`,
      data:  { type: 'wallet_unfrozen' },
    };
  },

  p2pReceived(amount, senderName) {
    return {
      title: 'Dinero recibido',
      body:  `${senderName} te envió Bs. ${Number(amount).toFixed(2)}.`,
      data:  { type: 'p2p_received' },
    };
  },
};
