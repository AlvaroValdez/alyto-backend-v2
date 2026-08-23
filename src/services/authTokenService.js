/**
 * authTokenService.js — Credencial intermedia del segundo factor.
 *
 * Entre validar la contraseña y emitir la sesión hay un estado que antes no
 * existía: el acceso está pendiente del segundo factor. Ese estado necesita una
 * credencial propia, porque el cliente tiene que poder volver a hablar con el
 * servidor sin haber obtenido todavía una sesión.
 *
 * La credencial intermedia es un token firmado, de vida corta, que sirve para
 * exactamente dos cosas: completar el alta del segundo factor y presentar el
 * código. NO sirve para nada más, y `protect()` la rechaza de plano — ese
 * rechazo es la pieza crítica: sin él, el token intermedio sería una sesión con
 * otro nombre y el control entero quedaría sin efecto.
 *
 * Vive atada a la versión de credencial del usuario, de modo que un cierre de
 * sesión o un restablecimiento de contraseña invalidan también los intentos de
 * segundo factor en curso.
 */

import jwt from 'jsonwebtoken';

/** Marca que distingue la credencial intermedia de una sesión. */
export const CHALLENGE_PURPOSE = 'admin_2fa_challenge';

/**
 * Vigencia de la credencial intermedia.
 *
 * Cinco minutos: alcanzan de sobra para abrir la aplicación de autenticación y
 * teclear seis dígitos, y acotan la ventana en que una contraseña sustraída
 * mantiene un intento a medio camino.
 */
export const CHALLENGE_TTL_SECONDS = 5 * 60;

/**
 * Métodos de autenticación que acreditó una sesión, en la convención `amr` de
 * OpenID Connect. Una sesión emitida por el camino de segundo factor los lleva;
 * una emitida sólo con contraseña, no.
 */
export const AMR_PASSWORD      = 'pwd';
export const AMR_OTP           = 'otp';
export const AMR_RECOVERY_CODE = 'rc';

/**
 * Emite la credencial intermedia.
 *
 * @param {object} p
 * @param {string|object} p.userId
 * @param {number} [p.tokenVersion]
 * @param {boolean} [p.enrollmentRequired] — true si además debe darse de alta
 * @returns {string}
 */
export function generateChallengeToken({ userId, tokenVersion = 0, enrollmentRequired = false }) {
  return jwt.sign(
    {
      id:      String(userId),
      purpose: CHALLENGE_PURPOSE,
      tokenVersion,
      enrollmentRequired: enrollmentRequired === true,
    },
    process.env.JWT_SECRET,
    { expiresIn: CHALLENGE_TTL_SECONDS },
  );
}

/**
 * Verifica la credencial intermedia. Devuelve las reclamaciones o null.
 *
 * @param {string} token
 * @returns {{ id: string, tokenVersion: number, enrollmentRequired: boolean } | null}
 */
export function verifyChallengeToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded?.purpose !== CHALLENGE_PURPOSE) return null;
    return {
      id:                 String(decoded.id),
      tokenVersion:       decoded.tokenVersion ?? 0,
      enrollmentRequired: decoded.enrollmentRequired === true,
    };
  } catch {
    return null;
  }
}

/**
 * ¿Este token tiene un propósito acotado y por tanto NO es una sesión?
 *
 * Todo verificador de credenciales del proyecto tiene que consultarlo. La
 * credencial intermedia lleva el mismo `id` y la misma versión que una sesión: lo
 * ÚNICO que la distingue es esta marca. Un verificador que no la mire concede,
 * con una contraseña y sin segundo factor, todo lo que ese verificador protege
 * —y el control queda eludido por la puerta de al lado, no por la principal.
 *
 * @param {object} claims — payload ya verificado
 * @returns {boolean}
 */
export function isScopedToken(claims) {
  return typeof claims?.purpose === 'string' && claims.purpose !== '';
}

/**
 * ¿Estas reclamaciones acreditan un segundo factor?
 *
 * Se usa para exigirlo también a las sesiones ya emitidas: al encender la
 * bandera en producción, las sesiones vivas de los operadores fueron emitidas
 * sólo con contraseña y no llevan la marca, de modo que quedan fuera del panel y
 * deben volver a entrar por el camino completo. Sin esta comprobación, la
 * exigencia sólo alcanzaría a quien iniciara sesión después del cambio.
 *
 * @param {object} claims — payload del JWT de sesión
 * @returns {boolean}
 */
export function claimsProveSecondFactor(claims) {
  const amr = claims?.amr;
  if (!Array.isArray(amr)) return false;
  return amr.includes(AMR_OTP) || amr.includes(AMR_RECOVERY_CODE);
}

export default {
  CHALLENGE_PURPOSE, CHALLENGE_TTL_SECONDS,
  AMR_PASSWORD, AMR_OTP, AMR_RECOVERY_CODE,
  generateChallengeToken, verifyChallengeToken, claimsProveSecondFactor,
  isScopedToken,
};
