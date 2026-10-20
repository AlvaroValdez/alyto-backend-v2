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

import * as Sentry    from '@sentry/node';
import User           from '../models/User.js';
import Notification   from '../models/Notification.js';
import { logger }     from '../utils/logger.js';

// ─── Inicialización lazy (dinámica) de Firebase ───────────────────────────────
// Se usa import() dinámico para que un fallo de Firebase NO bloquee el arranque
// del servidor ni impida el envío de emails transaccionales.

let firebaseAdmin = null;

/** Evita repetir en Sentry el mismo aviso de "Firebase sin configurar" por proceso. */
let avisoFirebaseEnviado = false;

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
      logger.info('[FCM] Firebase inicializado ✅');
    } else {
      logger.warn('[FCM] Variables Firebase no configuradas — push deshabilitado');
    }
  } catch (error) {
    logger.warn('[FCM] Firebase no disponible', { error: error.message });
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
 * Limpia tokens expirados automáticamente. Nunca lanza.
 *
 * ⚠️ **Siempre devuelve un resultado, nunca `undefined`.** Antes salía con `return`
 * pelado en cuatro caminos distintos y ninguno dejaba rastro: el que más pesa es
 * "el usuario no tiene ningún token", que en producción era la mayoría (45 de 64
 * notificaciones en 7 días no salieron por eso, con 18 de 25 usuarios sin token).
 * El resultado quedaba indistinguible de un envío exitoso, y así es como las push
 * de Android estuvieron caídas desde que existe la app sin que nada avisara.
 *
 * `reason` es la razón por la que NO se entregó; si se intentó, viene `'enviado'`.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {{ title: string, body: string, data?: Record<string,string> }} notification
 * @returns {Promise<{ delivered: number, attempted: number, reason: string }>}
 */
export async function sendPushNotification(userId, notification) {
  const tipo = notification?.data?.type ?? 'unknown';
  const uid  = userId?.toString();

  if (!firebaseAdmin) {
    // Sistémico y accionable: si falta una credencial, NINGÚN usuario recibe push.
    // Se avisa a Sentry una sola vez por proceso para que el aviso no se ahogue en
    // repeticiones, pero el log sí sale en cada intento.
    logger.warn('[Alyto FCM] NO ENTREGADA: Firebase no está inicializado — revisar FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY', { userId: uid, type: tipo });
    if (!avisoFirebaseEnviado) {
      avisoFirebaseEnviado = true;
      Sentry.captureMessage('FCM deshabilitado: Firebase Admin no inicializado', { level: 'error' });
    }
    return { delivered: 0, attempted: 0, reason: 'firebase_no_configurado' };
  }

  // ── 1. Buscar usuario, tokens FCM y preferencias ─────────────────────────
  let user;
  try {
    user = await User.findById(userId).select('fcmTokens preferences').lean();
  } catch (err) {
    logger.error('[Alyto FCM] NO ENTREGADA: error buscando al usuario', { userId: uid, type: tipo, error: err.message });
    Sentry.captureException(err, { tags: { service: 'notifications', fn: 'sendPushNotification' } });
    return { delivered: 0, attempted: 0, reason: 'usuario_ilegible' };
  }

  if (!user?.fcmTokens?.length) {
    // El caso mayoritario, y el que estaba completamente mudo. NO va a Sentry: hoy
    // son 18 de 25 usuarios y lo ahogaría todo. El log con marca fija alcanza para
    // medirlo (`grep 'SIN TOKENS'`) y para que deje de ser invisible.
    logger.warn('[Alyto FCM] NO ENTREGADA: SIN TOKENS — el usuario no tiene ningún dispositivo registrado', { userId: uid, type: tipo });
    return { delivered: 0, attempted: 0, reason: 'sin_tokens' };
  }

  // Respetar preferencia del usuario — undefined/true = enviar, false = no enviar.
  // Esta es la ÚNICA no-entrega legítima: la pidió el usuario.
  if (user.preferences?.notifications?.push === false) {
    logger.info('[Alyto FCM] No entregada por preferencia del usuario', { userId: uid, type: tipo });
    return { delivered: 0, attempted: 0, reason: 'push_desactivado_por_usuario' };
  }

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

  // Los motivos de fallo, no solo el conteo. Antes el log decía "failed: 2" sin
  // decir por qué, así que un fallo sistémico (credencial mala, cuota agotada,
  // remitente que no corresponde al proyecto) se veía igual que un token viejo.
  const motivosFallo = results
    .map(r => (r.status === 'rejected'
      ? (r.reason?.code ?? r.reason?.message ?? 'promesa_rechazada')
      : (r.value?.ok ? null : (r.value?.stale ? 'token_expirado' : (r.value?.error ?? 'desconocido')))))
    .filter(Boolean);

  const entregada = successful > 0;
  const detalle = {
    userId:      userId?.toString(),
    type:        notification.data?.type ?? 'unknown',
    total:       results.length,
    successful,
    failed,
    staleTokens: staleTokens.length,
    ...(motivosFallo.length ? { motivosFallo } : {}),
  };

  if (entregada) {
    logger.info('[Alyto FCM] Notificación enviada.', detalle);
  } else {
    // Tenía tokens y ninguno recibió: esto sí es una falla, no una ausencia.
    logger.error('[Alyto FCM] NO ENTREGADA: tenía tokens y ninguno aceptó el envío', detalle);
    Sentry.captureMessage('FCM: notificación no entregada a ningún dispositivo', {
      level: 'warning',
      extra: detalle,
    });
  }

  // ── 4. Limpiar tokens expirados de MongoDB ───────────────────────────────
  if (staleTokens.length > 0) {
    try {
      await User.updateOne(
        { _id: userId },
        { $pull: { fcmTokens: { $in: staleTokens } } },
      );
      logger.info('[Alyto FCM] Tokens expirados eliminados.', {
        userId: userId?.toString(),
        count:  staleTokens.length,
      });
    } catch (err) {
      logger.error('[Alyto FCM] Error eliminando tokens expirados:', {
        userId: userId?.toString(),
        error:  err.message,
      });
    }
  }

  return { delivered: successful, attempted: results.length, reason: 'enviado' };
}

// ─── notify() — Persiste + Push en un solo paso ──────────────────────────────

/**
 * Persiste la notificación en MongoDB y envía push vía FCM.
 * Nunca lanza excepción — ambos pasos son fire-and-forget.
 *
 * Los dos pasos son independientes a propósito: la notificación tiene que quedar
 * en la campana de la app aunque la push falle. Pero eso crea una trampa — el
 * usuario la ve al abrir y nadie nota que nunca recibió el aviso. Por eso el
 * resultado del envío ya no se descarta.
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
    logger.error('[Alyto Notify] Error persistiendo notificación:', {
      userId: userId?.toString(),
      type:   notification.data?.type,
      error:  err.message,
    });
  }

  // 2. Enviar push FCM — sigue siendo fire-and-forget (no debe frenar el flujo de
  //    dinero que lo invoca), pero un fallo inesperado ya no se descarta: antes
  //    había un `.catch(() => {})` que borraba toda huella de la excepción.
  sendPushNotification(userId, notification).catch((err) => {
    logger.error('[Alyto Notify] Error inesperado enviando push', {
      userId: userId?.toString(),
      type:   notification.data?.type,
      error:  err?.message,
    });
    Sentry.captureException(err, { tags: { service: 'notifications', fn: 'notify' } });
  });
}

// ─── notifyAdmins() — Persiste + Push + Email a todos los admins ─────────────

/**
 * Envía notificación in-app + push a TODOS los usuarios con role='admin'.
 * Opcionalmente envía email al SENDGRID_ADMIN_EMAIL.
 *
 * @param {{ title: string, body: string, data?: Record<string,string> }} notification
 * @param {{ email?: [string, string, object] }} opts — Si se pasa email, se envía vía SendGrid
 */
export async function notifyAdmins(notification, opts = {}) {
  try {
    const admins = await User.find({ role: 'admin' }).select('_id').lean();
    if (!admins.length) {
      logger.warn('[Alyto NotifyAdmins] No hay usuarios admin registrados.');
      return;
    }

    // In-app + push para cada admin (en paralelo, fire-and-forget)
    await Promise.allSettled(admins.map(a => notify(a._id, notification)));

    logger.info('[Alyto NotifyAdmins] Notificación enviada.', {
      type:       notification.data?.type ?? 'general',
      adminCount: admins.length,
    });
  } catch (err) {
    logger.error('[Alyto NotifyAdmins] Error', { error: err.message });
  }

  // Email al admin (opcional)
  if (opts.email) {
    try {
      const { sendEmail } = await import('./email.js');
      await sendEmail(...opts.email);
    } catch (err) {
      logger.error('[Alyto NotifyAdmins] Error enviando email', { error: err.message });
    }
  }
}

// ─── Plantillas de notificaciones predefinidas ────────────────────────────────

export const NOTIFICATIONS = {

  /**
   * Transferencia iniciada — el usuario acaba de crear la operación,
   * aún no pagó. Notifica por push + in-app para que pueda hacer seguimiento.
   * @param {number} originAmount
   * @param {string} originCurrency
   * @param {string} destinationCountry
   * @param {string} txId  alytoTransactionId (para deep link desde la campana)
   */
  transferInitiated(originAmount, originCurrency, destinationCountry, txId) {
    return {
      title: '¡Transferencia iniciada! 🚀',
      body:  `Tu transferencia de ${Number(originAmount).toLocaleString('es-CL')} ${originCurrency} a ${destinationCountry} fue creada. Te avisaremos cuando recibamos tu pago.`,
      data:  { type: 'transfer_initiated', txId },
    };
  },

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

  // Depósito USDC on-chain recibido (SEP-24 / Stellar) — acreditado en la wallet.
  usdcDepositReceived(amount) {
    return {
      title: 'USDC recibido ✓',
      body:  `Recibiste ${Number(amount).toFixed(2)} USDC en tu wallet Alyto. El depósito fue acreditado.`,
      data:  { type: 'usdc_deposit_received', amount: String(amount) },
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

  usdcReceived(amount, senderName) {
    return {
      title: '💵 USDC recibido',
      body:  `${senderName} te envió ${Number(amount).toFixed(2)} USDC.`,
      data:  { type: 'usdc_p2p_received' },
    };
  },

  adminUsdcP2pTransfer(amount, senderName, receiverName) {
    return {
      title: 'Transferencia USDC P2P',
      body:  `${senderName} → ${receiverName}: ${Number(amount).toFixed(2)} USDC.`,
      data:  { type: 'admin_usdc_p2p_transfer' },
    };
  },

  // ── Conversión BOB → USDC ─────────────────────────────────────────────────

  conversionConfirmed(bobAmount, usdcAmount) {
    return {
      title: 'Conversión completada ✓',
      body:  `Tu conversión de Bs. ${Number(bobAmount).toFixed(2)} fue acreditada: ${Number(usdcAmount).toFixed(6)} USDC.`,
      data:  { type: 'conversion_confirmed' },
    };
  },

  conversionRejected(bobAmount, reason) {
    return {
      title: 'Conversión no procesada',
      body:  `Tu solicitud de conversión de Bs. ${Number(bobAmount).toFixed(2)} no pudo completarse${reason ? `: ${reason}` : '.'}. Los fondos fueron devueltos a tu wallet.`,
      data:  { type: 'conversion_rejected' },
    };
  },

  // ── Conversión USDC → BOB (inversa, in-wallet) ────────────────────────────

  conversionToBobConfirmed(usdcAmount, bobAmount) {
    return {
      title: 'Conversión a BOB acreditada ✓',
      body:  `Convertiste ${Number(usdcAmount).toFixed(6)} USDC → Bs. ${Number(bobAmount).toFixed(2)} en tu wallet.`,
      data:  { type: 'usdc_to_bob_confirmed' },
    };
  },

  conversionToBobRejected(usdcAmount, reason) {
    return {
      title: 'Conversión a BOB no procesada',
      body:  `Tu conversión de ${Number(usdcAmount).toFixed(6)} USDC a BOB no pudo completarse${reason ? `: ${reason}` : '.'}. El USDC sigue en tu wallet.`,
      data:  { type: 'usdc_to_bob_rejected' },
    };
  },

  // ── Admin — Alertas de movimientos de usuarios ────────────────────────────

  adminNewUser(userName, email, entity) {
    return {
      title: 'Nuevo usuario registrado',
      body:  `${userName} (${email}) se registró en ${entity}.`,
      data:  { type: 'admin_new_user' },
    };
  },

  adminAccountDeletion(userName, email, entity) {
    return {
      title: 'Solicitud de eliminación de cuenta',
      body:  `${userName} (${email}) solicitó eliminar su cuenta en ${entity}. Datos retenidos por plazo legal ASFI/UIF.`,
      data:  { type: 'admin_account_deletion' },
    };
  },

  adminNewTransaction(txId, amount, currency, corridor) {
    return {
      title: 'Nueva transferencia creada',
      body:  `${txId}: ${Number(amount).toLocaleString('es-CL')} ${currency} (${corridor}).`,
      data:  { type: 'admin_new_transaction', txId },
    };
  },

  adminDepositRequest(amount, userName) {
    return {
      title: 'Depósito pendiente',
      body:  `${userName} solicitó un depósito de Bs. ${Number(amount).toFixed(2)}.`,
      data:  { type: 'admin_deposit_request' },
    };
  },

  adminWithdrawalRequest(amount, userName) {
    return {
      title: 'Retiro solicitado',
      body:  `${userName} solicitó un retiro de Bs. ${Number(amount).toFixed(2)}.`,
      data:  { type: 'admin_withdrawal_request' },
    };
  },

  adminDisbursementStuck(amount, wtxId) {
    return {
      title: 'Dispersión sin confirmar',
      body:  `El retiro ${wtxId} (Bs. ${Number(amount).toFixed(2)}) fue enviado al banco pero no llegó la confirmación. Verificar en BANECO y liquidar.`,
      data:  { type: 'admin_disbursement_stuck', wtxId },
    };
  },

  adminConversionRequest(bobAmount, usdcAmount, userName) {
    return {
      title: 'Conversión BOB→USDC pendiente',
      body:  `${userName} solicitó convertir Bs. ${Number(bobAmount).toFixed(2)} → ${Number(usdcAmount).toFixed(6)} USDC.`,
      data:  { type: 'admin_conversion_request' },
    };
  },

  adminUsdcToBobRequest(usdcAmount, bobAmount, userName) {
    return {
      title: 'Conversión USDC→BOB pendiente',
      body:  `${userName} solicitó convertir ${Number(usdcAmount).toFixed(6)} USDC → Bs. ${Number(bobAmount).toFixed(2)}.`,
      data:  { type: 'admin_usdc_to_bob_request' },
    };
  },

  adminKybSubmitted(businessName, userName) {
    return {
      title: 'Nueva solicitud KYB',
      body:  `${userName} envió solicitud KYB para "${businessName}".`,
      data:  { type: 'admin_kyb_submitted' },
    };
  },

  adminPaymentProof(txId, userName) {
    return {
      title: 'Comprobante subido',
      body:  `${userName} subió comprobante de pago para ${txId}.`,
      data:  { type: 'admin_payment_proof', txId },
    };
  },

  adminP2PTransfer(amount, senderName, receiverName) {
    return {
      title: 'Transferencia P2P',
      body:  `${senderName} envió Bs. ${Number(amount).toFixed(2)} a ${receiverName}.`,
      data:  { type: 'admin_p2p_transfer' },
    };
  },
};
