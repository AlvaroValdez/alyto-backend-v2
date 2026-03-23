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

  next();
}

export default checkAdmin;
