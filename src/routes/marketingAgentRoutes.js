/**
 * marketingAgentRoutes.js — Panel admin del agente de marketing (feature-gated)
 *
 * Montado en server.js SOLO si MARKETING_AGENT_ENABLED está activo. Acceso admin.
 * Prefijo: /api/v1/admin/marketing
 *
 * ⚠️ Nota de rollback: apagar el flag desmonta TODO el router, incluidas las
 * rutas de lectura y de aprobación. Si en ese momento hay piezas en
 * `pendiente_aprobacion`, quedan sin interfaz para resolverse. Para drenar la
 * cola hay que volver a encender el flag. Se eligió así por consistencia con
 * anchorAdminRoutes y ledgerAdminRoutes (mismo patrón de montaje condicional);
 * las piezas nunca se pierden, solo dejan de ser visibles mientras el flag esté
 * apagado.
 */

import { Router }     from 'express'
import { protect }    from '../middlewares/authMiddleware.js'
import { checkAdmin } from '../middlewares/checkAdmin.js'
import {
  generar,
  listarPendientes,
  listarPublicables,
  listarHistorial,
  aprobar,
  rechazar,
  estadoModulo,
  publicar,
  destrabar,
} from '../controllers/marketingAgentController.js'

const router = Router()

router.use(protect, checkAdmin)

router.get ('/estado',        estadoModulo)      // flag + modelo + conteo por estado
router.post('/generar',       generar)           // { tarea } → genera, clasifica y persiste
router.get ('/pendientes',    listarPendientes)  // cola de aprobación (más viejas primero)
router.get ('/publicables',   listarPublicables) // listas para salir al aire
router.get ('/historial',     listarHistorial)   // todas, paginado + filtros
router.post('/:id/aprobar',   aprobar)           // gate humano: visto bueno
router.post('/:id/rechazar',  rechazar)          // gate humano: descarte ({ motivo } opcional)
router.post('/:id/publicar',  publicar)          // sale a la red — irreversible desde acá
router.post('/:id/destrabar', destrabar)         // libera un intento que no cerró

export default router
