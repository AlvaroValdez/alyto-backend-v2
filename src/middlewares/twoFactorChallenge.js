/**
 * twoFactorChallenge.js — Acceso a los puntos del segundo factor.
 *
 * Las rutas de alta, confirmación y verificación se alcanzan ÚNICAMENTE con la
 * credencial intermedia que emite el login tras validar la contraseña. No
 * aceptan una sesión: si la aceptaran, quien ya tiene acceso podría rehacerse el
 * factor sin volver a acreditar nada, y el restablecimiento con motivo del
 * apartado 7.4.2 quedaría con un camino paralelo sin registro.
 *
 * Debe ejecutarse en lugar de protect(), no después.
 */

import { verifyChallengeToken } from '../services/authTokenService.js';

/**
 * Exige una credencial intermedia válida y la deja en `req.twoFactorChallenge`.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireTwoFactorChallenge(req, res, next) {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.split(' ')[1]
    : null;

  // Deliberadamente no se lee la cookie de sesión: la credencial intermedia
  // viaja siempre en la cabecera, y aceptarla por cookie abriría la puerta a que
  // una sesión ya emitida entrara por aquí.
  const claims = verifyChallengeToken(bearer);

  if (!claims) {
    return res.status(401).json({
      error: 'Vuelve a iniciar sesión para continuar con la verificación.',
      code:  'CHALLENGE_REQUIRED',
    });
  }

  req.twoFactorChallenge = claims;
  next();
}

export default requireTwoFactorChallenge;
