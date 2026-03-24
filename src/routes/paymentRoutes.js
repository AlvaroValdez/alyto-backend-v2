/**
 * paymentRoutes.js — Rutas de Pagos de Alyto V2.0
 *
 * Prefijo registrado en server.js: /api/v1/payments
 *
 * Endpoints disponibles:
 *   POST /api/v1/payments/payin/fintoc        — Inicia payin Chile (SpA)
 *   POST /api/v1/payments/webhooks/fintoc     — Webhook de confirmación Fintoc
 *
 * NOTA DE SEGURIDAD — Webhook raw body:
 *   El endpoint de webhook necesita acceder al body crudo (sin parsear) para
 *   verificar la firma HMAC-SHA256 de Fintoc. Se usa un middleware local que
 *   guarda req.rawBody antes de que express.json() lo consuma.
 */

import { Router }                                          from 'express';
import {
  initiateFintocPayin,
  fintocWebhook,
  getQuote,
  getTransactionStatus,
  getTransactionHistory,
  getWithdrawalRulesController,
  initCrossBorderPayment,
  getTransactionAudit,
  getAvailableCorridors,
} from '../controllers/paymentController.js';
import { protect, requireEntity }                          from '../middlewares/authMiddleware.js';

const router = Router();

// ─── Middleware: captura el raw body para verificación de firma de webhooks ──

/**
 * Middleware que almacena el body crudo en req.rawBody.
 * Solo se aplica a los endpoints de webhook que necesitan verificar firmas.
 */
function captureRawBody(req, res, next) {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end',  ()    => {
    req.rawBody = data;
    try {
      req.body = JSON.parse(data);
    } catch {
      req.body = {};
    }
    next();
  });
}

// ─── Rutas ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/payments/quote
 *
 * Cotización en tiempo real para un crossBorderPayment.
 * Retorna el desglose de fees y el monto estimado que recibirá el beneficiario.
 *
 * Query params: originCountry, destinationCountry, originAmount
 * Auth: Bearer JWT
 *
 * Ejemplo:
 *   GET /api/v1/payments/quote?originCountry=CL&destinationCountry=CO&originAmount=500000
 */
router.get('/quote', protect, getQuote);

/**
 * GET /api/v1/payments/corridors
 *
 * Corredores disponibles para el usuario autenticado, filtrados por su
 * entidad legal (SpA→CLP, SRL→BOB, LLC→USD).
 * Incluye nombre del país destino y emoji de bandera para el frontend.
 *
 * Auth: Bearer JWT
 */
router.get('/corridors', protect, getAvailableCorridors);

/**
 * GET /api/v1/payments/withdrawal-rules/:countryCode
 *
 * Devuelve los campos de formulario normalizados para el país destino indicado.
 * Respuesta cacheada en memoria por 1 hora. Fallback a reglas hardcodeadas
 * para CO y PE si Vita no responde.
 *
 * Params: countryCode — ISO alpha-2 mayúsculas (ej. CO, PE, AR)
 * Auth:   Bearer JWT
 */
router.get('/withdrawal-rules/:countryCode', protect, getWithdrawalRulesController);

/**
 * POST /api/v1/payments/crossborder
 *
 * Inicia un pago cross-border vía Vita Wallet.
 * Crea una payment_order en Vita, registra la transacción en BD con
 * los datos del beneficiario (formato dinámico o legado), y devuelve
 * la URL del widget de pago.
 *
 * Body: { corridorId, originAmount, beneficiaryData | beneficiary }
 * Auth: Bearer JWT
 */
router.post('/crossborder', protect, initCrossBorderPayment);

/**
 * POST /api/v1/payments/payin/fintoc
 *
 * Inicia un payin vía Fintoc Open Banking para usuarios SpA (Chile).
 * Requiere: { userId, amount (CLP, entero) }
 * Devuelve: { widgetUrl, widgetToken, alytoTransactionId, ... }
 */
// Requiere JWT válido + usuario bajo AV Finance SpA (Chile)
router.post('/payin/fintoc', protect, requireEntity(['SpA']), initiateFintocPayin);

/**
 * POST /api/v1/payments/webhooks/fintoc
 *
 * Endpoint de callback de Fintoc — llamado por sus servidores, no por el cliente.
 * Usa express.json() global (ya aplicado en server.js) — NO captureRawBody.
 * Fintoc envía JSON estándar; solo Stripe requiere raw body para su HMAC.
 * Debe estar registrado en el panel de Fintoc como webhook URL.
 */
router.post('/webhooks/fintoc', fintocWebhook);

/**
 * GET /api/v1/payments/transactions
 *
 * Historial de transacciones del usuario autenticado con paginación.
 * El usuario solo ve sus propias transacciones (userId extraído del JWT).
 *
 * Query params opcionales:
 *   status {String}  — filtrar por un status exacto
 *   page   {Number}  — default 1
 *   limit  {Number}  — default 10, máx. 50
 *
 * IMPORTANTE: Esta ruta debe estar ANTES de /:transactionId/status para
 * evitar que "transactions" se interprete como un transactionId.
 *
 * Auth: Bearer JWT
 */
router.get('/transactions', protect, getTransactionHistory);

/**
 * GET /api/v1/payments/:transactionId/audit
 *
 * Verifica el audit trail blockchain de una transacción completada.
 * Retorna el TXID de Stellar, explorerUrl y detalles del ledger.
 *
 * Params: transactionId — alytoTransactionId
 * Auth:   Bearer JWT
 */
router.get('/:transactionId/audit', protect, getTransactionAudit);

/**
 * GET /api/v1/payments/:transactionId/status
 *
 * Consulta el estado actual de una transacción del usuario autenticado.
 * El usuario solo puede ver sus propias transacciones (userId verificado en BD).
 * Diseñado para polling del frontend (~5s) durante el flujo de pago activo.
 *
 * Params: transactionId — alytoTransactionId (ej. "ALY-B-1710000000000-XYZ123")
 * Auth:   Bearer JWT
 *
 * Respuestas:
 *   200 — Objeto de estado de la transacción (sin datos internos)
 *   401 — Token inválido o ausente
 *   404 — Transacción no encontrada o no pertenece al usuario
 *   500 — Error interno del servidor
 */
router.get('/:transactionId/status', protect, getTransactionStatus);

export default router;
