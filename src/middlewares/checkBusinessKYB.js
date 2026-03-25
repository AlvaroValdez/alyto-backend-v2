/**
 * checkBusinessKYB.js — Middleware de acceso a funcionalidades Business
 *
 * Restringe rutas que requieren cuenta Business aprobada:
 * - Corredores OwlPay (bo-us-owlpay, bo-eu, bo-mx-llc, bo-br-llc)
 * - Operaciones con tickets altos (> $10.000 USD)
 * - Transferencias institucionales B2B
 *
 * Uso:
 *   import { checkBusinessKYB } from '../middlewares/checkBusinessKYB.js';
 *   router.post('/institutional', protect, checkBusinessKYB, handler);
 *
 * Prerrequisito: el middleware protect() debe correr antes para que req.user exista.
 */

/**
 * Verifica que el usuario tiene cuenta Business con KYB aprobado.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function checkBusinessKYB(req, res, next) {
  const { accountType, kybStatus } = req.user ?? {};

  if (accountType !== 'business' || kybStatus !== 'approved') {
    return res.status(403).json({
      error:    'Cuenta Business requerida.',
      message:  'Este servicio está disponible exclusivamente para cuentas Business verificadas. '
              + 'Solicita tu cuenta Business en POST /api/v1/kyb/apply.',
      kybStatus: kybStatus ?? 'not_started',
      kybApplyUrl: '/api/v1/kyb/apply',
    });
  }

  next();
}
