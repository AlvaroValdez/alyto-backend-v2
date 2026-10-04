/**
 * kycRetryNudge.js — Invita a retomar la verificación a quien se quedó a medias.
 *
 * El 2026-10-02 un usuario quedó bloqueado porque la página alojada de Stripe le
 * falló al cargar. El sistema lo detectó y lo devolvió a 'pending', pero nadie se
 * lo dijo: desde su lado, Alyto simplemente no funcionaba. Arreglar el estado sin
 * avisar al usuario deja el problema igual de intacto, porque quien se fue no
 * tiene ningún motivo para volver.
 *
 * Dos públicos distintos, con mensajes distintos (ver [sendKycRetryEmail]):
 *   'interrumpida' — lanzó la biometría y no terminó. "Puedes reintentar."
 *   'sin_iniciar'  — se registró y nunca la abrió. "Te falta este paso."
 *
 * Tres frenos, porque un aviso automático mal acotado es correo basura:
 *   1. Tope de avisos por usuario (KYC_NUDGE_MAX_AVISOS, 2 por defecto). Después
 *      de dos recordatorios, insistir no informa: molesta.
 *   2. Solo se repite si hubo un intento NUEVO desde el último aviso. Alguien que
 *      no volvió a intentar no recibe un segundo correo por el mero paso del
 *      tiempo.
 *   3. Periodo de gracia (KYC_NUDGE_GRACIA_HORAS, 2 h) desde el alta o el último
 *      intento: no se le escribe a quien está en mitad del proceso ahora mismo.
 *
 * Y dos salvaguardas operativas:
 *   - Dominios internos excluidos (KYC_NUDGE_SKIP_DOMAINS): las cuentas de
 *     prueba y de administración comparten los mismos estados que un usuario real.
 *   - Tope por corrida (KYC_NUDGE_MAX_POR_CORRIDA): SendGrid está en plan
 *     gratuito con un límite duro de 100 correos diarios, y al superarlo falla
 *     con "Maximum credits exceeded" afectando TODO el correo transaccional
 *     (confirmaciones de pago incluidas). Un aviso de cortesía no puede tumbar eso.
 *
 * Cómo se programa: lo invoca [kycIncompleteMonitor] (cada 6 h, con regla de
 * EventBridge ya provisionada) y está registrado como `kyc-retry-nudge`.
 * Gate: KYC_RETRY_NUDGE_ENABLED.
 */

import User from '../models/User.js';
import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';

const hora = 60 * 60 * 1000;

function config() {
  // Leído dentro de la función (regla 21): en el ámbito del módulo capturaría los
  // valores previos a la carga de secretos.
  return {
    habilitado:     process.env.KYC_RETRY_NUDGE_ENABLED === 'true',
    maxAvisos:      Number(process.env.KYC_NUDGE_MAX_AVISOS      || 2),
    graciaMs:       Number(process.env.KYC_NUDGE_GRACIA_HORAS    || 2) * hora,
    maxPorCorrida:  Number(process.env.KYC_NUDGE_MAX_POR_CORRIDA || 25),
    dominiosExcluidos: (process.env.KYC_NUDGE_SKIP_DOMAINS
      ?? 'avfinance.net,avfinance.com,alyto.app,alyto.io')
      .split(',').map(d => d.trim().toLowerCase()).filter(Boolean),
  };
}

function esDominioInterno(email, dominios) {
  const dom = String(email ?? '').split('@')[1]?.toLowerCase();
  return !!dom && dominios.includes(dom);
}

/**
 * Decide si un usuario debe recibir aviso, y de qué tipo.
 * Exportada para poder ejercitar el criterio sin tocar correo ni base.
 *
 * @param {object} user
 * @param {{ahora?: number, cfg?: object, ultimoIntentoAt?: Date|null}} [ctx]
 *   ultimoIntentoAt — fecha del último intento registrado ([KycAttempt]). NO usar
 *   `user.updatedAt` en su lugar: cambia con cualquier escritura sobre el usuario,
 *   así que el propio barrido que lo devuelve a 'pending' lo metería en el periodo
 *   de gracia y lo dejaría sin aviso. Null cuando no hay intentos registrados
 *   (usuarios anteriores a la bitácora): entonces manda la fecha de alta.
 * @returns {{avisar: boolean, variante?: 'interrumpida'|'sin_iniciar', motivo: string}}
 */
export function evaluarUsuario(user, { ahora = Date.now(), cfg = config(), ultimoIntentoAt = null } = {}) {
  if (user.kycStatus !== 'pending')  return { avisar: false, motivo: 'estado_no_pendiente' };
  if (!user.emailVerified)           return { avisar: false, motivo: 'email_sin_verificar' };
  if (user.isActive === false)       return { avisar: false, motivo: 'cuenta_inactiva' };
  if (user.deletedAt)                return { avisar: false, motivo: 'cuenta_borrada' };
  if (esDominioInterno(user.email, cfg.dominiosExcluidos)) {
    return { avisar: false, motivo: 'dominio_interno' };
  }

  const nudge = user.kycNudge ?? {};
  if ((nudge.count ?? 0) >= cfg.maxAvisos) return { avisar: false, motivo: 'tope_de_avisos' };

  const sesionActual = user.stripeVerificationSessionId ?? null;
  const variante     = sesionActual ? 'interrumpida' : 'sin_iniciar';

  // Periodo de gracia: el reloj corre desde el último intento si lo hubo, y desde
  // el alta si no. Evita escribirle a quien está verificando ahora mismo.
  const referencia = new Date(ultimoIntentoAt ?? user.createdAt).getTime();
  if (ahora - referencia < cfg.graciaMs) return { avisar: false, motivo: 'dentro_de_gracia' };

  if (nudge.sentAt) {
    // Repetir SOLO si hubo un intento nuevo desde el último aviso. Si la sesión es
    // la misma (o sigue sin haberla), el usuario no hizo nada nuevo y un segundo
    // correo no le aporta información, solo insiste.
    if ((nudge.sessionId ?? null) === sesionActual) {
      return { avisar: false, motivo: 'ya_avisado_sin_intento_nuevo' };
    }
  }

  return { avisar: true, variante, motivo: 'procede' };
}

/**
 * @param {{dryRun?: boolean}} [opts] dryRun evalúa y reporta sin enviar ni escribir.
 */
export async function kycRetryNudge(opts = {}) {
  const cfg    = config();
  const dryRun = opts.dryRun === true;

  if (!cfg.habilitado && !dryRun) {
    logger.info('[KYC Aviso] KYC_RETRY_NUDGE_ENABLED no está activo — no se envía nada.');
    return { processed: 0, enviados: 0, omitidos: 0, deshabilitado: true };
  }

  try {
    const candidatos = await User.find({ kycStatus: 'pending' })
      .select('_id email firstName legalEntity kycStatus emailVerified isActive deletedAt ' +
              'stripeVerificationSessionId kycNudge createdAt')
      .lean();

    // Fecha del último intento por usuario, en una sola consulta. Es la referencia
    // del periodo de gracia; ver la nota en evaluarUsuario sobre por qué no sirve
    // `updatedAt`.
    const { default: KycAttempt } = await import('../models/KycAttempt.js');
    const ultimos = await KycAttempt.aggregate([
      { $match: { userId: { $in: candidatos.map(u => u._id) } } },
      { $group: { _id: '$userId', ultimo: { $max: '$createdAt' } } },
    ]);
    const ultimoPorUsuario = new Map(ultimos.map(r => [String(r._id), r.ultimo]));

    const ahora     = Date.now();
    const elegibles = [];
    const omitidos  = {};

    for (const u of candidatos) {
      const v = evaluarUsuario(u, {
        ahora, cfg, ultimoIntentoAt: ultimoPorUsuario.get(String(u._id)) ?? null,
      });
      if (v.avisar) elegibles.push({ user: u, variante: v.variante });
      else omitidos[v.motivo] = (omitidos[v.motivo] ?? 0) + 1;
    }

    const aEnviar = elegibles.slice(0, cfg.maxPorCorrida);
    if (elegibles.length > aEnviar.length) {
      // Sin esta línea, un recorte por cuota se lee igual que "no había nadie más".
      logger.warn('[KYC Aviso] Tope por corrida alcanzado; quedan usuarios sin avisar', {
        tope: cfg.maxPorCorrida, pendientes: elegibles.length - aEnviar.length,
      });
    }

    if (dryRun) {
      logger.info('[KYC Aviso] SIMULACIÓN (no se envió nada)', {
        candidatos: candidatos.length, elegibles: elegibles.length, omitidos,
      });
      return {
        dryRun: true, processed: candidatos.length, omitidos,
        destinatarios: aEnviar.map(e => ({
          email: e.user.email, nombre: e.user.firstName, variante: e.variante,
        })),
      };
    }

    const { sendKycRetryEmail } = await import('../services/email.js');
    const { notify }            = await import('../services/notifications.js');

    let enviados = 0;
    for (const { user, variante } of aEnviar) {
      try {
        await sendKycRetryEmail(user, variante);

        // Push y bandeja de la aplicación: fire-and-forget (regla 13). Que falle
        // el aviso dentro de la app no puede impedir el correo, que es el canal
        // que alcanza a quien ya no la tiene abierta.
        notify(user._id, {
          title: variante === 'interrumpida'
            ? 'Tu verificación quedó a medias'
            : 'Te falta verificar tu identidad',
          body: variante === 'interrumpida'
            ? 'No llegó a completarse. Puedes retomarla cuando quieras, toma menos de dos minutos.'
            : 'Es el paso que falta para que puedas enviar dinero con Alyto.',
          data: { type: 'kyc_retry_nudge', variante },
        }).catch(() => {});

        await User.updateOne({ _id: user._id }, {
          $set: {
            'kycNudge.sentAt':    new Date(),
            'kycNudge.sessionId': user.stripeVerificationSessionId ?? null,
          },
          $inc: { 'kycNudge.count': 1 },
        });

        enviados += 1;
        logger.info('[KYC Aviso] Enviado', {
          userId: String(user._id), email: user.email, variante,
        });
      } catch (err) {
        // Un destinatario que falla no puede cortar el resto de la tanda.
        logger.warn('[KYC Aviso] No se pudo avisar', {
          userId: String(user._id), email: user.email, error: err.message,
        });
      }
    }

    logger.info('[KYC Aviso] Terminado', {
      candidatos: candidatos.length, elegibles: elegibles.length, enviados, omitidos,
    });
    return { processed: candidatos.length, enviados, omitidos };

  } catch (err) {
    logger.error('[KYC Aviso] Error', { error: err.message });
    Sentry.captureException(err, { tags: { job: 'kycRetryNudge' } });
    return { processed: 0, enviados: 0, error: err.message };
  }
}

export default kycRetryNudge;
