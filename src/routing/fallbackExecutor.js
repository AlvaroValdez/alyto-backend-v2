/**
 * fallbackExecutor.js — Motor de Resiliencia con Fallback Automático
 *
 * Ejecuta cada etapa del flujo (payin → transit → payout) intentando el
 * proveedor primario primero. Si falla, promueve al siguiente sin detener
 * el servidor ni exponer datos sensibles en los logs.
 *
 * Patrón: Chain of Responsibility sobre el array de proveedores de cada etapa.
 */

import registry from './providerRegistry.js';

/**
 * Ejecuta una lista de proveedores en orden, usando el siguiente si el anterior falla.
 *
 * @param {string[]} providers  - IDs de proveedor en orden de preferencia
 * @param {string}   stage      - 'payin' | 'transit' | 'payout'
 * @param {object}   payload    - Datos específicos de la etapa
 * @returns {Promise<{providerId: string, result: object}>}
 * @throws {Error} si todos los proveedores de la etapa fallan
 */
export async function runWithFallback(providers, stage, payload) {
  const errors = [];

  for (const providerId of providers) {
    const provider = registry.get(providerId);

    if (!provider) {
      console.warn(`[Alyto Router] Proveedor "${providerId}" no encontrado en registry. Saltando.`);
      continue;
    }

    try {
      const result = await provider.execute(payload);
      if (errors.length > 0) {
        // Hubo fallback — registrar para auditoría sin interrumpir el flujo
        console.info(`[Alyto Router] Etapa "${stage}" completada por fallback: ${providerId}`);
      }
      return { providerId, result };
    } catch (err) {
      // Registrar sin exponer datos sensibles del payload (userId, claves)
      console.warn(`[Alyto Router] "${providerId}" (${stage}) falló. Intentando siguiente proveedor.`, {
        providerId,
        stage,
        error: err.message,
      });
      errors.push({ providerId, error: err.message });
    }
  }

  // Todos los proveedores de esta etapa fallaron
  const detail = errors.map(e => `${e.providerId}: ${e.error}`).join(' | ');
  throw new Error(`[Alyto Router] Todos los proveedores de "${stage}" fallaron → ${detail}`);
}

/**
 * Ejecuta el flujo completo de pago siguiendo la RouteDefinition entregada por transactionRouter.
 *
 * Flujo secuencial:
 *   1. Pay-in      (si route.payinProviders tiene elementos)
 *   2. Tránsito    (Stellar / OwlPay — siempre presente)
 *   3. Pay-out     (si route.payoutProviders tiene elementos)
 *   4. Compliance  (si route.requiresBoliviaCompliance — invoca Compliance_Bolivia_Alyto)
 *
 * @param {RouteDefinition} route
 * @param {PaymentRequestDTO} request
 * @returns {Promise<ExecutionResult>}
 *
 * @typedef {Object} ExecutionResult
 * @property {string}   transactionId
 * @property {string|null} txid           - TXID de Stellar (disponible tras el tránsito)
 * @property {string[]} providersUsed     - Registro de qué proveedor ejecutó cada etapa
 */
export async function executeWithFallback(route, request) {
  const providersUsed = [];
  let txid = null;

  // ── Paso 1: Pay-in ───────────────────────────────────────────────────────
  if (route.payinProviders.length > 0) {
    const { providerId } = await runWithFallback(
      route.payinProviders,
      'payin',
      buildPayinPayload(request),
    );
    providersUsed.push(`payin:${providerId}`);
  }

  // ── Paso 2: Tránsito (Stellar / OwlPay) ─────────────────────────────────
  // Ver Stellar_Integration_Alyto para reglas de Fee Bump y trustlines
  if (route.transitProviders.length > 0) {
    const { providerId, result } = await runWithFallback(
      route.transitProviders,
      'transit',
      buildTransitPayload(request),
    );
    txid = result?.txid ?? null;
    providersUsed.push(`transit:${providerId}`);
  }

  // ── Paso 3: Pay-out / Off-ramp ───────────────────────────────────────────
  if (route.payoutProviders.length > 0) {
    const { providerId } = await runWithFallback(
      route.payoutProviders,
      'payout',
      buildPayoutPayload(request, txid),
    );
    providersUsed.push(`payout:${providerId}`);
  }

  // ── Paso 4: Compliance Bolivia (Escenario C) ─────────────────────────────
  // Activa Compliance_Bolivia_Alyto: genera Comprobante Oficial de Transacción
  // Requiere que request.boliviaComplianceData esté completamente populado con
  // los datos KYC (NIT/CI), desglose financiero y datos de AV Finance SRL.
  if (route.requiresBoliviaCompliance && txid) {
    try {
      const { generarComprobanteBolivia } = await import(
        '../services/compliance/bolivia/pdfService.js'
      );
      await generarComprobanteBolivia(buildBoliviaCompliancePayload(request, txid));
      providersUsed.push('compliance:boliviaComprobante');
    } catch (err) {
      // No interrumpir el pago — el comprobante puede regenerarse bajo demanda
      console.error('[Alyto Compliance] Error generando Comprobante Bolivia:', {
        txid,
        error: err.message,
      });
    }
  }

  return {
    transactionId: generateTransactionId(route.scenario),
    txid,
    providersUsed,
  };
}

// ─── Helpers de construcción de payloads ────────────────────────────────────
// Solo incluyen campos necesarios para cada etapa — no se pasan claves ni secrets.

function buildPayinPayload({ amount, currency, userId }) {
  return { amount, currency, userId };
}

function buildTransitPayload({ amount, currency, stellarDestAddress, userId }) {
  return { amount, currency, stellarDestAddress, userId };
}

function buildPayoutPayload({ amount, destinationCountry, userId }, txid) {
  return { amount, destinationCountry, userId, stellarTxid: txid };
}

function buildBoliviaCompliancePayload(request, txid) {
  // El caller (paymentOrchestrator) es responsable de enriquecer
  // request.boliviaComplianceData con todos los campos de TransaccionBoliviaDTO
  // antes de invocar executeWithFallback. Ver Compliance_Bolivia_Alyto.
  return {
    txid,
    tipoOperacion: 'Liquidación de Activo Digital',
    ...request.boliviaComplianceData,
  };
}

function generateTransactionId(scenario) {
  const ts     = Date.now();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `ALY-${scenario}-${ts}-${random}`;
}
