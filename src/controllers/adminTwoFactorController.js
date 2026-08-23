/**
 * adminTwoFactorController.js — Puntos de entrada del segundo factor.
 *
 * Traduce a HTTP lo que decide adminTwoFactorService. Dos familias de rutas:
 *
 *   1. Las del propio operador, que se alcanzan con la credencial intermedia
 *      emitida por el login: alta, confirmación y verificación. Ninguna acepta
 *      una sesión — si las aceptara, quien ya entró podría rehacerse el factor.
 *
 *   2. La del panel: consulta del estado de alta del conjunto de operadores y
 *      restablecimiento del factor de un tercero, que exige motivo y queda
 *      asentado en la bitácora de acciones administrativas (apdo. 7.4.2).
 *
 * ⚠️ El secreto sólo sale del sistema en la respuesta del alta, una vez. No
 * aparece en ninguna otra respuesta, ni en las bitácoras.
 */

import mongoose from 'mongoose';
import QRCode   from 'qrcode';

import User from '../models/User.js';
import { logger } from '../utils/logger.js';
import { recordAdminAction } from '../services/adminAuditService.js';
import {
  registerFailedAttempt, registerSuccess, registerBlocked,
  isLockedOut,
} from '../services/accessLogService.js';
import {
  beginEnrollment, confirmEnrollment, verifySecondFactor, consumeRecoveryCode,
  resetSecondFactor, enrollmentStatus,
  hasConfirmedSecondFactor, twoFactorPolicy,
  MIN_RESET_REASON_LENGTH,
} from '../services/adminTwoFactorService.js';
import {
  issueSession,
} from './authController.js';
import {
  AMR_PASSWORD, AMR_OTP, AMR_RECOVERY_CODE,
} from '../services/authTokenService.js';

/**
 * Respuesta genérica del punto de verificación. El motivo preciso va al registro
 * de accesos, no al cliente: distinguir «código inválido» de «código ya usado»
 * le diría a quien está probando si acertó el código y llegó tarde.
 */
const GENERIC_2FA_ERROR = 'Código inválido o vencido.';

/** Carga el usuario de la credencial intermedia y comprueba que siga siendo válido. */
async function loadChallengeUser(req, res) {
  // Se piden `twoFactor.enabled` y `twoFactor.confirmedAt`, NO la rama entera:
  // nombrar la ruta padre anula el `select:false` de sus hijos y arrastraría a
  // memoria el secreto cifrado y los diez hashes de recuperación, que luego pasan
  // por `issueSession` y por la bitácora. Hoy ninguna respuesta los expondría
  // —todas arman su salida con lista blanca—, pero un dato sensible que no hace
  // falta cargar es un descuido esperando a que alguien agregue un spread.
  const user = await User.findById(req.twoFactorChallenge.id)
    .select('email role isActive tokenVersion firstName lastName legalEntity kycStatus kybStatus accountType emailVerified kycProfileCompletedAt avatarUrl country failedLoginAttempts lockedUntil twoFactor.enabled twoFactor.confirmedAt twoFactor.resetAt')
    .lean();

  if (!user || !user.isActive) {
    res.status(401).json({ error: 'No autorizado.', code: 'CHALLENGE_INVALID' });
    return null;
  }
  // La credencial intermedia queda atada a la versión de credencial: un cierre de
  // sesión o un restablecimiento de contraseña la invalidan de inmediato.
  if ((user.tokenVersion ?? 0) !== (req.twoFactorChallenge.tokenVersion ?? 0)) {
    res.status(401).json({ error: 'No autorizado.', code: 'CHALLENGE_STALE' });
    return null;
  }
  return user;
}

// ─── Alta ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/2fa/enroll   (credencial intermedia)
 *
 * Genera el secreto y lo devuelve como código QR y como cadena para ingreso
 * manual. NO activa nada: hasta confirmar con un código válido, la cuenta sigue
 * sin segundo factor.
 */
export async function enroll(req, res) {
  try {
    const user = await loadChallengeUser(req, res);
    if (!user) return;

    // El alta también respeta el bloqueo. Sin esto era el único de los tres
    // puntos que no lo miraba, y como cada llamada reemplaza el secreto pendiente,
    // servía para invalidar el que el operador legítimo acababa de escanear.
    if (isLockedOut(user)) {
      await registerBlocked({ req, email: user.email, user, factor: 'totp' });
      return res.status(401).json({ error: GENERIC_2FA_ERROR, code: 'LOCKED_OUT' });
    }

    const { secret, manualEntry, otpauthUri } = await beginEnrollment({ userId: user._id });

    // El QR va como imagen embebida: pedirle al cliente que construya el URI
    // significaría mandarle el secreto por un segundo camino sin necesidad.
    const qrDataUrl = await QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: 'M', margin: 1, width: 240 });

    return res.status(200).json({
      qrDataUrl,
      manualEntry,
      policy: twoFactorPolicy(),
      message: 'Escanea el código con tu aplicación de autenticación y confirma con un código para activarlo.',
    });

  } catch (err) {
    if (err.code === 'ALREADY_ENROLLED') {
      return res.status(409).json({ error: err.message, code: 'ALREADY_ENROLLED' });
    }
    logger.error('[2fa] Error en el alta del segundo factor', { error: err.message });
    return res.status(500).json({ error: 'No se pudo iniciar la configuración del segundo factor.' });
  }
}

/**
 * POST /api/v1/auth/2fa/confirm   (credencial intermedia)
 * Body: { code }
 *
 * Activa el factor y entrega los códigos de recuperación por única vez. Como el
 * operador ya acreditó contraseña y código, la sesión se emite en el mismo acto.
 */
export async function confirm(req, res) {
  try {
    const user = await loadChallengeUser(req, res);
    if (!user) return;

    if (isLockedOut(user)) {
      await registerBlocked({ req, email: user.email, user, factor: 'totp' });
      return res.status(401).json({ error: GENERIC_2FA_ERROR, code: 'LOCKED_OUT' });
    }

    const result = await confirmEnrollment({ userId: user._id, code: req.body?.code });

    if (!result.ok) {
      await registerFailedAttempt({ req, email: user.email, reason: result.reason, user, factor: 'totp' });
      return res.status(401).json({ error: GENERIC_2FA_ERROR });
    }

    await registerSuccess({ req, email: user.email, user, factor: 'totp' });

    // El alta queda asentada en la bitácora de administración, no sólo en el
    // registro de accesos. Importa por lo que el alta acredita realmente: se
    // confirma con el primer factor, así que quien tenga la contraseña de una
    // cuenta SIN factor configurado puede darse de alta el suyo. Ese estado no es
    // hipotético —lo produce a propósito cada restablecimiento del apdo. 7.4.2, y
    // también el alta de un operador nuevo—, de modo que la defensa disponible es
    // que el hecho quede registrado y se pueda contrastar contra el
    // restablecimiento que lo precede.
    await recordAdminAction({
      req,
      actor:      { _id: user._id, email: user.email, role: user.role },
      action:     'admin_2fa.enrolled',
      targetType: 'User',
      targetId:   String(user._id),
      after:      { enabled: true },
      reason:     'Alta de segundo factor confirmada por el titular',
      metadata:   { afterReset: !!user.twoFactor?.resetAt },
    });

    const session = issueSession(res, user, { amr: [AMR_PASSWORD, AMR_OTP] });

    return res.status(200).json({
      ...session,
      // Única vez que estos códigos existen en claro fuera del cliente.
      recoveryCodes: result.recoveryCodes,
      message: 'Segundo factor activado. Guarda los códigos de recuperación: no se volverán a mostrar.',
    });

  } catch (err) {
    logger.error('[2fa] Error confirmando el segundo factor', { error: err.message });
    return res.status(500).json({ error: 'No se pudo confirmar el segundo factor.' });
  }
}

// ─── Verificación ─────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/2fa/verify   (credencial intermedia)
 * Body: { code } o { recoveryCode }
 *
 * Único punto donde se emite la sesión de un acceso con privilegios.
 */
export async function verify(req, res) {
  try {
    const user = await loadChallengeUser(req, res);
    if (!user) return;

    const usaRecuperacion = typeof req.body?.recoveryCode === 'string' && req.body.recoveryCode.trim() !== '';
    const factor = usaRecuperacion ? 'recovery_code' : 'totp';

    // El bloqueo se comprueba antes de mirar el código: es la misma política del
    // punto de contraseña y, sobre el mismo contador, se aplica una sola vez.
    if (isLockedOut(user)) {
      await registerBlocked({ req, email: user.email, user, factor });
      return res.status(401).json({ error: GENERIC_2FA_ERROR, code: 'LOCKED_OUT' });
    }

    if (!hasConfirmedSecondFactor(user)) {
      await registerFailedAttempt({ req, email: user.email, reason: 'totp_not_enrolled', user, factor });
      return res.status(403).json({
        error: 'Debes configurar tu segundo factor de autenticación antes de continuar.',
        code:  'ENROLLMENT_REQUIRED',
      });
    }

    const result = usaRecuperacion
      ? await consumeRecoveryCode({ userId: user._id, code: req.body.recoveryCode })
      : await verifySecondFactor({ userId: user._id, code: req.body?.code });

    if (!result.ok) {
      await registerFailedAttempt({ req, email: user.email, reason: result.reason, user, factor });
      return res.status(401).json({ error: GENERIC_2FA_ERROR });
    }

    await registerSuccess({ req, email: user.email, user, factor });

    if (usaRecuperacion) {
      // El consumo de un código de recuperación queda asentado en la bitácora de
      // acciones administrativas: es un ingreso por la puerta de emergencia de una
      // cuenta privilegiada, y tiene que poder revisarse junto al resto de lo que
      // hace un administrador, no sólo en el registro de accesos.
      await recordAdminAction({
        req,
        actor:      { _id: user._id, email: user.email, role: user.role },
        action:     'admin_2fa.recovery_code_used',
        targetType: 'User',
        targetId:   String(user._id),
        after:      { recoveryRemaining: result.remaining },
        reason:     'Acceso con código de recuperación de un solo uso',
      });
    }

    const rememberMe = req.body?.rememberMe === true;
    const session    = issueSession(res, user, {
      rememberMe,
      amr: [AMR_PASSWORD, usaRecuperacion ? AMR_RECOVERY_CODE : AMR_OTP],
    });

    return res.status(200).json({
      ...session,
      ...(usaRecuperacion && { recoveryRemaining: result.remaining }),
    });

  } catch (err) {
    logger.error('[2fa] Error verificando el segundo factor', { error: err.message });
    return res.status(500).json({ error: 'No se pudo verificar el código.' });
  }
}

// ─── Panel ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/2fa/status   (sesión de administrador)
 *
 * Estado de alta del conjunto de operadores. Es lo que permite decidir cuándo
 * encender la bandera en producción sin dejar a nadie fuera del panel.
 */
export async function status(req, res) {
  try {
    const estado = await enrollmentStatus();
    return res.status(200).json({
      ...estado,
      readyToEnforce: estado.total > 0 && estado.pending.length === 0,
    });
  } catch (err) {
    logger.error('[2fa] Error consultando el estado de alta', { error: err.message });
    return res.status(500).json({ error: 'No se pudo consultar el estado del segundo factor.' });
  }
}

/**
 * POST /api/v1/admin/users/:userId/2fa/reset   (sesión de administrador)
 * Body: { reason }
 *
 * Borra el segundo factor de un operador para que lo vuelva a dar de alta. Acción
 * sensible del apartado 7.4.2: motivo obligatorio, persistido, con autor y momento.
 */
export async function reset(req, res) {
  try {
    const { userId } = req.params;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: 'Identificador de usuario inválido.' });
    }

    if (reason.length < MIN_RESET_REASON_LENGTH) {
      return res.status(400).json({
        error: `Restablecer el segundo factor exige un motivo de al menos ${MIN_RESET_REASON_LENGTH} caracteres (queda registrado en la auditoría).`,
        code:  'REASON_REQUIRED',
      });
    }

    // Se canonicaliza el identificador: ObjectId acepta el hexadecimal en
    // mayúsculas y castea al mismo documento, pero el actor propio sale siempre
    // en minúsculas. Comparar las cadenas crudas dejaría pasar el auto-servicio.
    const targetId = String(new mongoose.Types.ObjectId(userId));

    // Nadie se restablece su propio segundo factor: sería quitarse el control a
    // sí mismo con la sesión que ese mismo control habilitó. La misma segregación
    // de funciones que ya rige los cambios de rol y de estado de identidad.
    if (targetId === String(req.user._id)) {
      return res.status(403).json({
        error: 'No puedes restablecer tu propio segundo factor. Debe hacerlo otro administrador.',
        code:  'SELF_MUTATION_FORBIDDEN',
      });
    }

    const target = await User.findById(targetId).select('email role').lean();
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const { before, after } = await resetSecondFactor({ userId: targetId, actorId: req.user._id });

    const auditLog = await recordAdminAction({
      req,
      action:     'admin_2fa.reset',
      targetType: 'User',
      targetId,
      before,
      after,
      reason,
      metadata:   { targetEmail: target.email, targetRole: target.role },
    });

    return res.status(200).json({
      message: 'Segundo factor restablecido. El usuario deberá configurarlo de nuevo en su próximo acceso.',
      twoFactor: after,
      auditLogId: auditLog?._id ?? null,
    });

  } catch (err) {
    logger.error('[2fa] Error restableciendo el segundo factor', { error: err.message });
    return res.status(500).json({ error: 'No se pudo restablecer el segundo factor.' });
  }
}

export default { enroll, confirm, verify, status, reset };
