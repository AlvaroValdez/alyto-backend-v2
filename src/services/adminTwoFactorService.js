/**
 * adminTwoFactorService.js — Segundo factor de autenticación para accesos con
 * privilegios de administración.
 *
 * Cubre el Artículo 2°, inciso c, Sección 4 del Reglamento para Empresas de
 * Tecnología Financiera: identificación y autenticación robusta, auditable y
 * trazable. Hasta aquí, una contraseña sustraída concedía acceso al panel hasta
 * su revocación; los controles vigentes —vencimiento acotado, revocación por
 * versión de credencial, limitación de tasa y bloqueo por intentos— acotaban esa
 * ventana pero no la cerraban.
 *
 * Decisiones de diseño y su porqué:
 *
 *   Método TOTP y no un código por correo o mensaje. El correo ya es el primer
 *   factor de recuperación de la contraseña: un segundo factor sobre el mismo
 *   canal no agrega separación, sólo la apariencia de ella. El mensaje de texto
 *   agrega un tercero (la operadora) al perímetro de una cuenta privilegiada.
 *
 *   El alta no habilita nada hasta que se confirma con un código válido. Un
 *   secreto generado y no confirmado significa que el operador no lo tiene en su
 *   teléfono; darlo por bueno lo dejaría fuera de su propio panel.
 *
 *   El contador de intentos es el MISMO que el de la contraseña. Ver
 *   accessLogService.registerFailedAttempt.
 *
 *   El secreto se cifra siempre, sin camino alternativo en claro. A diferencia
 *   del documento de identidad —que tiene un modo heredado sin cifrar—, aquí no
 *   hay valores previos que migrar: el control nace cifrado y falla cerrado si la
 *   clave de datos no está disponible.
 *
 * Patrón servicio + controlador: aquí vive la decisión, en el controlador la
 * traducción a HTTP.
 */

import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

import User from '../models/User.js';
import { logger } from '../utils/logger.js';
import { recordAdminAction } from './adminAuditService.js';
import {
  ensureDek, encryptField, decryptField, aadForTotpSecret,
} from './piiCrypto.js';
import {
  generateSecret, verifyTotp, otpauthUri, formatSecretForManualEntry,
  timeStep, TOTP_STEP_SECONDS, TOTP_WINDOW, TOTP_DIGITS,
} from '../utils/totp.js';

/** Cantidad de códigos de recuperación que se entregan en el alta. */
export const RECOVERY_CODE_COUNT = 10;

/** Coste bcrypt de los códigos de recuperación — el mismo de las contraseñas. */
const RECOVERY_CODE_COST = 10;

/** Longitud mínima del motivo en un restablecimiento (igual que el resto del panel). */
export const MIN_RESET_REASON_LENGTH = 10;

// ─── Bandera de activación ────────────────────────────────────────────────────

/**
 * ¿El segundo factor es exigible?
 *
 * Se lee dentro de la función (regla 21: nunca capturar entorno en el ámbito de
 * módulo, o se toma el valor anterior a la carga de secretos). Por defecto
 * DESACTIVADO: encenderlo antes de que todos los operadores completen su alta
 * dejaría la administración inaccesible.
 */
export function isAdminTwoFactorEnabled() {
  return process.env.ADMIN_2FA_ENABLED === 'true';
}

/** ¿Este usuario está alcanzado por la exigencia? Sólo los roles con privilegios. */
export function requiresTwoFactor(user) {
  return isAdminTwoFactorEnabled() && user?.role === 'admin';
}

/** Parámetros del control, para exponerlos en la evidencia sin duplicar constantes. */
export function twoFactorPolicy() {
  return {
    algorithm:    'TOTP (RFC 6238) / HMAC-SHA1',
    digits:       TOTP_DIGITS,
    stepSeconds:  TOTP_STEP_SECONDS,
    window:       TOTP_WINDOW,
    recoveryCodes: RECOVERY_CODE_COUNT,
    enabled:      isAdminTwoFactorEnabled(),
  };
}

// ─── Estado del segundo factor de una cuenta ──────────────────────────────────

/**
 * ¿La cuenta tiene el segundo factor confirmado y utilizable?
 * Función pura para poder probarla sin base de datos.
 *
 * @param {{ twoFactor?: { enabled?: boolean, confirmedAt?: Date|null } }} user
 * @returns {boolean}
 */
export function hasConfirmedSecondFactor(user) {
  return user?.twoFactor?.enabled === true && !!user?.twoFactor?.confirmedAt;
}

// ─── Alta ─────────────────────────────────────────────────────────────────────

/**
 * Genera un secreto y lo deja PENDIENTE de confirmación.
 *
 * Devuelve el secreto en claro una única vez, para que el controlador lo pinte
 * como código QR y como cadena de ingreso manual. A partir de ese retorno el
 * valor no vuelve a salir de la base: queda sólo el ciphertext.
 *
 * Reiniciar el alta de una cuenta ya confirmada NO está permitido por esta vía —
 * eso es un restablecimiento y exige motivo (ver `resetSecondFactor`).
 *
 * @param {object} p
 * @param {string|mongoose.Types.ObjectId} p.userId
 * @returns {Promise<{ secret: string, manualEntry: string, otpauthUri: string }>}
 */
export async function beginEnrollment({ userId }) {
  const user = await User.findById(userId).select('email role twoFactor').lean();
  if (!user) throw Object.assign(new Error('Usuario no encontrado.'), { code: 'USER_NOT_FOUND' });

  if (hasConfirmedSecondFactor(user)) {
    throw Object.assign(
      new Error('La cuenta ya tiene segundo factor configurado. Reconfigurarlo exige un restablecimiento con motivo.'),
      { code: 'ALREADY_ENROLLED' },
    );
  }

  // Falla cerrado: sin clave de datos disponible no se da de alta un factor cuyo
  // secreto no se podría cifrar. Persistirlo en claro «mientras tanto» es
  // exactamente lo que la norma prohíbe.
  await ensureDek();

  const secret = generateSecret();

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        'twoFactor.secretCiphertext': encryptField(secret, aadForTotpSecret(user._id)),
        'twoFactor.enabled':          false,
        'twoFactor.confirmedAt':      null,
        'twoFactor.enrolledAt':       new Date(),
        'twoFactor.lastUsedStep':     0,
        'twoFactor.recoveryCodes':    [],
      },
    },
  );

  logger.info('[2fa] Alta iniciada — secreto generado, pendiente de confirmación', { userId: String(user._id) });

  return {
    secret,
    manualEntry: formatSecretForManualEntry(secret),
    otpauthUri:  otpauthUri({ secret, account: user.email, issuer: issuerName() }),
  };
}

/** Nombre que muestra la aplicación de autenticación. Distingue entornos. */
function issuerName() {
  const base = 'Alyto';
  const env  = process.env.NODE_ENV === 'production' ? '' : ` (${process.env.NODE_ENV ?? 'dev'})`;
  return `${base}${env}`;
}

/**
 * Confirma el alta con un código válido y activa el factor.
 *
 * Genera y devuelve los códigos de recuperación en claro por única vez. Se
 * persisten con la misma función de un solo sentido que las contraseñas: si la
 * base se filtra, no sirven para entrar.
 *
 * @param {object} p
 * @param {string|mongoose.Types.ObjectId} p.userId
 * @param {string} p.code
 * @returns {Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, reason: string }>}
 */
export async function confirmEnrollment({ userId, code, req = null, via = 'cli' }) {
  const user = await User.findById(userId)
    .select('email role twoFactor.enabled twoFactor.confirmedAt twoFactor.resetAt +twoFactor.secretCiphertext +twoFactor.lastUsedStep')
    .lean();
  if (!user) throw Object.assign(new Error('Usuario no encontrado.'), { code: 'USER_NOT_FOUND' });

  if (hasConfirmedSecondFactor(user)) {
    return { ok: false, reason: 'totp_replayed' };   // ya confirmado: no se reconfirma
  }
  if (!user.twoFactor?.secretCiphertext) {
    return { ok: false, reason: 'totp_not_enrolled' };
  }

  await ensureDek();
  const secret  = decryptField(user.twoFactor.secretCiphertext, aadForTotpSecret(user._id));
  const matched = verifyTotp(secret, code);
  if (matched === null) return { ok: false, reason: 'totp_invalid' };

  const { plain, hashed } = await generateRecoveryCodes();

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        'twoFactor.enabled':       true,
        'twoFactor.confirmedAt':   new Date(),
        'twoFactor.lastUsedStep':  matched,   // el código de confirmación queda consumido
        'twoFactor.recoveryCodes': hashed,
      },
    },
  );

  // El asiento se escribe ACÁ, no en el controlador. El alta ocurre por dos
  // caminos —el panel y la consola durante el despliegue inicial— y ponerlo en
  // el transporte dejaba sin registrar justamente las de consola, que son las
  // primeras de la entidad. Un asiento que existe según por dónde entró la
  // petición no sirve como evidencia de que "toda incorporación de un
  // autenticador es detectable": basta usar el otro camino para no aparecer.
  //
  // `via` deja constancia de cuál se usó, que es dato de auditoría por sí mismo:
  // un alta por consola implica acceso al servidor, no sólo la contraseña.
  await recordAdminAction({
    req,
    actor:      { _id: user._id, email: user.email, role: user.role },
    action:     'admin_2fa.enrolled',
    targetType: 'User',
    targetId:   String(user._id),
    after:      { enabled: true },
    reason:     'Alta de segundo factor confirmada por el titular',
    metadata:   { via, afterReset: !!user.twoFactor?.resetAt },
  });

  logger.info('[2fa] Alta confirmada — segundo factor activo', { userId: String(user._id), via });
  return { ok: true, recoveryCodes: plain };
}

// ─── Verificación ─────────────────────────────────────────────────────────────

/**
 * Verifica un código TOTP y lo marca como consumido.
 *
 * La prevención de reutilización se resuelve con una escritura condicional: sólo
 * avanza si el paso guardado sigue siendo menor que el que se pretende consumir.
 * Hacerlo en dos tiempos (leer, comparar, escribir) dejaría pasar dos peticiones
 * simultáneas con el mismo código, que es justamente el caso que importa cuando
 * alguien intercepta un código en tránsito.
 *
 * @param {object} p
 * @param {string|mongoose.Types.ObjectId} p.userId
 * @param {string} p.code
 * @returns {Promise<{ ok: true, step: number } | { ok: false, reason: 'totp_invalid'|'totp_replayed'|'totp_not_enrolled' }>}
 */
export async function verifySecondFactor({ userId, code }) {
  const user = await User.findById(userId)
    .select('twoFactor.enabled twoFactor.confirmedAt +twoFactor.secretCiphertext +twoFactor.lastUsedStep')
    .lean();
  if (!user) throw Object.assign(new Error('Usuario no encontrado.'), { code: 'USER_NOT_FOUND' });

  if (!hasConfirmedSecondFactor(user) || !user.twoFactor?.secretCiphertext) {
    return { ok: false, reason: 'totp_not_enrolled' };
  }

  await ensureDek();
  const secret  = decryptField(user.twoFactor.secretCiphertext, aadForTotpSecret(user._id));
  const matched = verifyTotp(secret, code);
  if (matched === null) return { ok: false, reason: 'totp_invalid' };

  const res = await User.updateOne(
    { _id: user._id, 'twoFactor.lastUsedStep': { $lt: matched } },
    { $set: { 'twoFactor.lastUsedStep': matched } },
  );
  if (res.modifiedCount !== 1) return { ok: false, reason: 'totp_replayed' };

  return { ok: true, step: matched };
}

// ─── Códigos de recuperación ──────────────────────────────────────────────────

/**
 * Genera el conjunto de códigos de recuperación: los devuelve en claro para
 * mostrarlos una única vez y hasheados para persistir.
 *
 * @returns {Promise<{ plain: string[], hashed: Array<{hash:string, usedAt:null}> }>}
 */
async function generateRecoveryCodes() {
  const { randomInt } = await import('node:crypto');
  const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin I, O, 0, 1: se transcriben mal

  const plain = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = Array.from({ length: 10 }, () => ALFABETO[randomInt(0, ALFABETO.length)]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });

  const hashed = await Promise.all(
    plain.map(async c => ({ hash: await bcrypt.hash(normalizeRecoveryCode(c), RECOVERY_CODE_COST), usedAt: null })),
  );

  return { plain, hashed };
}

/** Normaliza para comparar: sin guiones, sin espacios, en mayúsculas. */
export function normalizeRecoveryCode(code) {
  return String(code ?? '').toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Consume un código de recuperación. Un solo uso: el segundo intento con el
 * mismo código falla.
 *
 * @param {object} p
 * @param {string|mongoose.Types.ObjectId} p.userId
 * @param {string} p.code
 * @returns {Promise<{ ok: true, remaining: number } | { ok: false, reason: 'recovery_invalid'|'totp_not_enrolled' }>}
 */
export async function consumeRecoveryCode({ userId, code }) {
  const user = await User.findById(userId)
    .select('twoFactor.enabled twoFactor.confirmedAt +twoFactor.recoveryCodes')
    .lean();
  if (!user) throw Object.assign(new Error('Usuario no encontrado.'), { code: 'USER_NOT_FOUND' });
  if (!hasConfirmedSecondFactor(user)) return { ok: false, reason: 'totp_not_enrolled' };

  const candidate = normalizeRecoveryCode(code);
  if (!candidate) return { ok: false, reason: 'recovery_invalid' };

  const codes = user.twoFactor?.recoveryCodes ?? [];

  // Se recorren TODOS los códigos, incluidos los ya gastados, y sin cortar al
  // encontrar la coincidencia: comparar sólo los vigentes revelaría por tiempo de
  // respuesta cuántos quedan.
  let matchIndex = -1;
  for (let i = 0; i < codes.length; i++) {
    const coincide = await bcrypt.compare(candidate, codes[i].hash);
    if (coincide && !codes[i].usedAt && matchIndex === -1) matchIndex = i;
  }
  if (matchIndex === -1) return { ok: false, reason: 'recovery_invalid' };

  // Escritura condicional sobre el mismo índice: si dos peticiones traen el mismo
  // código, sólo una lo consume.
  const res = await User.updateOne(
    { _id: user._id, [`twoFactor.recoveryCodes.${matchIndex}.usedAt`]: null },
    { $set: { [`twoFactor.recoveryCodes.${matchIndex}.usedAt`]: new Date() } },
  );
  if (res.modifiedCount !== 1) return { ok: false, reason: 'recovery_invalid' };

  const remaining = codes.filter((c, i) => !c.usedAt && i !== matchIndex).length;
  logger.warn('[2fa] Código de recuperación consumido', { userId: String(user._id), remaining });

  return { ok: true, remaining };
}

// ─── Restablecimiento ─────────────────────────────────────────────────────────

/**
 * Borra el segundo factor de una cuenta para que su titular lo vuelva a dar de
 * alta. Es una acción sensible en el sentido del apartado 7.4.2: quien la ejecuta
 * deja a una cuenta privilegiada momentáneamente con un solo factor. Por eso el
 * motivo es obligatorio y la escritura de la bitácora corre por cuenta del
 * controlador, dentro de la misma operación.
 *
 * @param {object} p
 * @param {string|mongoose.Types.ObjectId} p.userId
 * @param {string|mongoose.Types.ObjectId} p.actorId
 * @returns {Promise<{ before: object, after: object }>}
 */
export async function resetSecondFactor({ userId, actorId }) {
  // Se piden explícitamente los códigos de recuperación —son select:false— para
  // que el estado ANTERIOR que va a la bitácora diga cuántos quedaban de verdad.
  // Sin ellos el registro afirmaría siempre cero, y un restablecimiento pedido
  // «porque no quedan códigos» no se podría contrastar después.
  const user = await User.findById(userId)
    .select('email role twoFactor.enabled twoFactor.confirmedAt +twoFactor.recoveryCodes')
    .lean();
  if (!user) throw Object.assign(new Error('Usuario no encontrado.'), { code: 'USER_NOT_FOUND' });

  const before = describeSecondFactor(user);

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        'twoFactor.enabled':          false,
        'twoFactor.secretCiphertext': null,
        'twoFactor.confirmedAt':      null,
        'twoFactor.enrolledAt':       null,
        'twoFactor.lastUsedStep':     0,
        'twoFactor.recoveryCodes':    [],
        'twoFactor.resetAt':          new Date(),
        'twoFactor.resetBy':          actorId ?? null,
      },
      // Toda credencial viva de esa cuenta queda revocada en el acto: si el
      // restablecimiento se pide porque el teléfono se perdió o se sospecha un
      // acceso indebido, dejar la sesión en curso vaciaría la medida.
      $inc: { tokenVersion: 1 },
    },
  );

  logger.warn('[2fa] Segundo factor restablecido por un administrador', {
    userId: String(user._id), actorId: String(actorId ?? ''),
  });

  return { before, after: { enabled: false, confirmedAt: null, recoveryRemaining: 0 } };
}

/**
 * Resumen del estado del segundo factor, apto para respuestas de la interfaz y
 * para la bitácora. No incluye el secreto ni los hashes.
 *
 * @param {object} user
 * @returns {{ enabled: boolean, confirmedAt: Date|null, recoveryRemaining: number }}
 */
export function describeSecondFactor(user) {
  const tf = user?.twoFactor ?? {};
  return {
    enabled:     tf.enabled === true,
    confirmedAt: tf.confirmedAt ?? null,
    recoveryRemaining: Array.isArray(tf.recoveryCodes)
      ? tf.recoveryCodes.filter(c => !c.usedAt).length
      : 0,
  };
}

/**
 * Estado de alta de todas las cuentas con privilegios. Es lo que permite decidir
 * si ya se puede encender la bandera en producción sin dejar a nadie fuera.
 *
 * @returns {Promise<{ total: number, enrolled: number, pending: Array<{id:string,email:string}>, policy: object }>}
 */
export async function enrollmentStatus() {
  const admins = await User.find({ role: 'admin', isActive: true })
    .select('email twoFactor.enabled twoFactor.confirmedAt')
    .lean();

  const pending = admins
    .filter(u => !hasConfirmedSecondFactor(u))
    .map(u => ({ id: String(u._id), email: u.email }));

  return {
    total:    admins.length,
    enrolled: admins.length - pending.length,
    pending,
    policy:   twoFactorPolicy(),
  };
}

export default {
  isAdminTwoFactorEnabled, requiresTwoFactor, twoFactorPolicy,
  hasConfirmedSecondFactor, describeSecondFactor, enrollmentStatus,
  beginEnrollment, confirmEnrollment, verifySecondFactor,
  consumeRecoveryCode, normalizeRecoveryCode, resetSecondFactor,
  timeStep,
};
