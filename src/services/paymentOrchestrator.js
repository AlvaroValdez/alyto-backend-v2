/**
 * paymentOrchestrator.js — Punto de Entrada del Motor de Pagos
 *
 * Orquesta un crossBorderPayment leyendo el perfil KYC/KYB del usuario
 * y delegando al router y ejecutor correspondientes.
 *
 * Este módulo NO ejecuta operaciones de red directamente — solo coordina:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  [API Controller]                                                 │
 *   │       │                                                           │
 *   │       ▼                                                           │
 *   │  paymentOrchestrator  ──► transactionRouter  (decide escenario)  │
 *   │       │                                                           │
 *   │       ▼                                                           │
 *   │  fallbackExecutor     ──► providers (stripe/fintoc/stellar/...)  │
 *   │       │                                                           │
 *   │       └──► [Escenario C] Compliance_Bolivia_Alyto → PDF          │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Skills dependientes invocados internamente:
 *   - Stellar_Integration_Alyto  → stellarProvider.js (tránsito)
 *   - Compliance_Bolivia_Alyto   → pdfService.js (Escenario C, destino=BO)
 *
 * NOTA DE COMPLIANCE: Ninguna variable ni comentario usa terminología prohibida.
 */

import { resolveRoute }        from '../routing/transactionRouter.js';
import { executeWithFallback } from '../routing/fallbackExecutor.js';

/**
 * Orquesta un crossBorderPayment o b2bTransfer según la jurisdicción del usuario.
 *
 * @param {PaymentRequestDTO} request
 * @returns {Promise<PaymentResultDTO>}
 *
 * @typedef {Object} PaymentResultDTO
 * @property {boolean}  success
 * @property {string}   operatingEntity   - Entidad legal AV Finance que procesó la operación
 * @property {string}   scenario          - 'A' | 'B' | 'C' | 'D'
 * @property {string}   transactionId     - ID interno Alyto (ALY-{scenario}-{ts}-{random})
 * @property {string|null} txid           - Hash de la transacción en Stellar Network
 * @property {string[]} providersUsed     - Auditoría de qué proveedor ejecutó cada etapa
 */
export async function orchestrateCrossBorderPayment(request) {
  // Validación mínima de campos obligatorios antes de continuar
  validateRequest(request);

  try {
    // ── 1. Resolución de ruta ─────────────────────────────────────────────
    // transactionRouter evalúa clientType, originCountry y destinationCountry
    // en orden de prioridad y retorna la RouteDefinition sin ejecutar nada.
    const route = resolveRoute(request);

    console.info('[Alyto Orchestrator] Ruta resuelta:', {
      userId:   request.userId,
      scenario: route.scenario,
      entity:   route.entity,
    });

    // ── 2. Ejecución del flujo con resiliencia ────────────────────────────
    // fallbackExecutor ejecuta payin → transit → payout en secuencia,
    // promoviendo automáticamente al proveedor secundario si el primario falla.
    const result = await executeWithFallback(route, request);

    return {
      success:         true,
      operatingEntity: route.entity,
      scenario:        route.scenario,
      transactionId:   result.transactionId,
      txid:            result.txid,
      providersUsed:   result.providersUsed,
    };

  } catch (error) {
    // Registrar para auditoría sin exponer datos sensibles del usuario
    console.error('[Alyto Orchestrator] crossBorderPayment fallido:', {
      userId:      request?.userId,
      origin:      request?.originCountry,
      destination: request?.destinationCountry,
      error:       error.message,
    });
    throw error;
  }
}

// ─── Validación de entrada ────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['userId', 'originCountry', 'destinationCountry', 'clientType', 'amount', 'currency'];

function validateRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new Error('[Alyto Orchestrator] request inválido: se esperaba un objeto PaymentRequestDTO');
  }

  const missing = REQUIRED_FIELDS.filter(f => request[f] == null || request[f] === '');
  if (missing.length > 0) {
    throw new Error(`[Alyto Orchestrator] Campos obligatorios faltantes: ${missing.join(', ')}`);
  }

  if (!['personal', 'corporate'].includes(request.clientType)) {
    throw new Error('[Alyto Orchestrator] clientType debe ser "personal" o "corporate"');
  }

  if (typeof request.amount !== 'number' || request.amount <= 0) {
    throw new Error('[Alyto Orchestrator] amount debe ser un número positivo');
  }
}
