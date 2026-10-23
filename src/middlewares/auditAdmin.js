/**
 * auditAdmin.js — Asiento de auditoría genérico para mutaciones admin de
 * CONFIGURACIÓN (Tier 2 del barrido 2026-10-05).
 *
 * El Tier 1 (acciones que mueven dinero de usuarios) lleva asientos a mano,
 * dentro de la sesión de Mongo, con before/after de saldos — ahí la atomicidad
 * es la garantía. El Tier 2 son mutaciones de configuración y estado (tasas,
 * QR, corredores, funding, jobs manuales): lo que importa asentar es QUIÉN
 * ejecutó QUÉ con QUÉ payload, y eso un middleware lo captura uniforme sin
 * cirugía en ~20 controllers.
 *
 * Diseño:
 *   - Se registra al TERMINAR la respuesta y solo si fue 2xx: una mutación
 *     rechazada (400/403/409) no es una acción ejecutada.
 *   - `after` = body redactado (redactSensitive corre dentro del servicio);
 *     para config, el body ES el estado nuevo. `targetId` sale del route param.
 *   - Fire-and-forget: si el asiento falla, el servicio alerta a Sentry sin
 *     tumbar una respuesta que ya salió. La versión fail-closed es la del
 *     Tier 1, donde hay dinero de por medio.
 *   - El `reason`/`note` del body viaja al asiento si el panel lo manda.
 *
 * Uso en rutas:
 *   router.patch('/corridors/:corridorId', auditAdmin('corridor.update', {
 *     targetType: 'TransactionConfig', targetParam: 'corridorId',
 *   }), updateCorridor)
 */

import { recordAdminAction } from '../services/adminAuditService.js'

/**
 * @param {string} action             nombre del asiento (ej. 'corridor.update')
 * @param {object} [opts]
 * @param {string} [opts.targetType]  modelo/config afectado
 * @param {string} [opts.targetParam] req.params de donde sale el targetId
 * @param {string} [opts.targetBodyKey] fallback: clave del body con el targetId
 */
export function auditAdmin(action, { targetType = '', targetParam = null, targetBodyKey = null } = {}) {
  return function auditAdminMiddleware(req, res, next) {
    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return

      const targetId =
        (targetParam   && req.params?.[targetParam])   ??
        (targetBodyKey && req.body?.[targetBodyKey])   ??
        ''

      // El body como "estado nuevo". Los archivos (multer) no van al asiento:
      // se referencia el nombre, no el contenido.
      const { reason, note, ...resto } = req.body ?? {}
      const after = {
        ...resto,
        ...(req.file ? { archivo: req.file.originalname, size: req.file.size } : {}),
      }

      recordAdminAction({
        req,
        action,
        targetType,
        targetId,
        after,
        reason: reason ?? note ?? '',
        metadata: { method: req.method, path: req.originalUrl },
      }).catch(() => {})   // el servicio ya alerta a Sentry; nunca tumbar la respuesta
    })

    next()
  }
}

export default auditAdmin
