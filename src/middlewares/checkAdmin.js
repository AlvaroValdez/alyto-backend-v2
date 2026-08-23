/**
 * checkAdmin.js — Middleware de autorización para el panel de administración.
 *
 * Verifica que el usuario autenticado (req.user) tenga role === 'admin'.
 * Debe ejecutarse DESPUÉS de protect() — requiere que req.user esté cargado.
 *
 * Uso en rutas:
 *   router.get('/endpoint', protect, checkAdmin, handler);
 *
 * O aplicado a todo un router:
 *   router.use(protect, checkAdmin);
 */

import { claimsProveSecondFactor } from '../services/authTokenService.js';
import { isAdminTwoFactorEnabled } from '../services/adminTwoFactorService.js';

/**
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function checkAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: 'No autorizado. Middleware protect() no ejecutado.',
    });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Acceso denegado. Se requiere rol de administrador.',
    });
  }

  // La sesión tiene que acreditar que el segundo factor se presentó, no sólo que
  // su titular es administrador. Sin esto, la exigencia alcanzaría únicamente a
  // quien iniciara sesión después de encender la bandera: las sesiones vivas en
  // ese momento —emitidas sólo con contraseña— seguirían entrando al panel
  // durante hasta siete días. Al no llevar la marca, quedan fuera y sus titulares
  // vuelven a entrar por el camino completo.
  if (isAdminTwoFactorEnabled() && !claimsProveSecondFactor(req.authClaims)) {
    return res.status(403).json({
      error: 'Acceso denegado. Vuelve a iniciar sesión y completa la verificación de segundo factor.',
      code:  'SECOND_FACTOR_REQUIRED',
    });
  }

  next();
}

export default checkAdmin;
