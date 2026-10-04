/**
 * kycStaleSessionSweeper.js — Resuelve las verificaciones que quedaron colgadas.
 *
 * `createKycSession` deja al usuario en 'in_review' apenas crea la sesión en
 * Stripe. Salir de ese estado dependía por completo de dos cosas: que llegara el
 * webhook, o que el usuario volviera a abrir la pantalla y disparara el polling.
 * Si ninguna ocurría, el usuario quedaba en 'in_review' indefinidamente. El
 * 2026-10-02 había uno así desde el 2026-08-29, con la sesión marcada
 * `abandoned` en Stripe desde el primer día.
 *
 * Esto no es solo cosmético: 'in_review' bloquea el onboarding igual que
 * 'pending', pero la pantalla dice "estamos revisando tu documentación", así que
 * el usuario espera en vez de reintentar.
 *
 * El barrido aplica el MISMO criterio que el polling —[resolveKycFromStripe]— así
 * que también recupera aprobaciones cuyo webhook se perdió, con todos sus efectos
 * (keypair custodial, screening AML, notificación).
 *
 * Cómo se programa: lo invoca [kycIncompleteMonitor] (cada 6 h, con regla de
 * EventBridge ya provisionada) y está registrado en `jobRegistry` como
 * `kyc-stale-sessions` para dispararlo a mano. Es idempotente: una doble
 * ejecución no produce ningún efecto distinto.
 */

import User from '../models/User.js';
import { resolveKycFromStripe } from '../services/kycSessionResolver.js';
import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';

/**
 * Tope por corrida. Cada usuario cuesta una llamada a Stripe; sin tope, una
 * acumulación inesperada convertiría el barrido en una tormenta de peticiones.
 */
const MAX_POR_CORRIDA = 200;

export async function kycStaleSessionSweeper() {
  const inicio = Date.now();

  try {
    const colgados = await User.find({
      kycStatus:                   'in_review',
      stripeVerificationSessionId: { $nin: [null, ''] },
    })
      .select('_id email kycStatus stripeVerificationSessionId')
      .sort({ updatedAt: 1 })   // los más viejos primero: son los que llevan más esperando
      .limit(MAX_POR_CORRIDA)
      .lean();

    if (!colgados.length) {
      logger.info('[KYC Barrido] Sin verificaciones en curso que revisar.');
      return { processed: 0, resueltos: 0 };
    }

    let resueltos = 0;
    let fallidos  = 0;

    for (const user of colgados) {
      try {
        const r = await resolveKycFromStripe(user);
        if (r.changed) {
          resueltos += 1;
          logger.info('[KYC Barrido] Verificación resuelta', {
            userId: String(user._id),
            email:  user.email,
            estado: r.kycStatus,
            motivo: r.reason,
          });
        }
      } catch (err) {
        // Un usuario que falla no puede cortar el barrido del resto.
        fallidos += 1;
        logger.warn('[KYC Barrido] No se pudo resolver', {
          userId:    String(user._id),
          sessionId: user.stripeVerificationSessionId,
          error:     err.message,
        });
      }
    }

    if (colgados.length === MAX_POR_CORRIDA) {
      logger.warn('[KYC Barrido] Se alcanzó el tope por corrida; quedan usuarios sin revisar', {
        tope: MAX_POR_CORRIDA,
      });
    }

    logger.info('[KYC Barrido] Terminado', {
      revisados: colgados.length,
      resueltos,
      fallidos,
      ms: Date.now() - inicio,
    });

    return { processed: colgados.length, resueltos, fallidos };

  } catch (err) {
    logger.error('[KYC Barrido] Error', { error: err.message });
    Sentry.captureException(err, { tags: { job: 'kycStaleSessionSweeper' } });
    return { processed: 0, resueltos: 0, error: err.message };
  }
}

export default kycStaleSessionSweeper;
