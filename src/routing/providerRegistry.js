/**
 * providerRegistry.js — Registro Central de Proveedores
 *
 * Factory de proveedores. Agregar un nuevo proveedor = una sola línea aquí.
 * El fallbackExecutor no importa proveedores directamente; los obtiene
 * por ID a través de este registro.
 *
 * Estado de proveedores:
 *   ✅ Activo    — integrado y disponible
 *   🔧 Stub      — interfaz lista, integración real pendiente
 *   ⏸ Pausado   — contrato/integración pendiente (NO registrar aquí)
 *
 * Proveedores PAUSADOS (ausentes del registry intencionalmente):
 *   - BP Ventures  (pendiente contrato)
 *   - Anclap/CLPX  (pendiente integración)
 */

import stripeProvider       from '../providers/payin/stripeProvider.js';
import fintocProvider       from '../providers/payin/fintocProvider.js';
import rampNetworkProvider  from '../providers/payin/rampNetworkProvider.js';
import owlPayProvider       from '../providers/transit/owlPayProvider.js';
import stellarProvider      from '../providers/transit/stellarProvider.js';
import anchorBoliviaProvider from '../providers/payout/anchorBoliviaProvider.js';
import vitaWalletProvider   from '../providers/payout/vitaWalletProvider.js';

const registry = new Map([
  // ── Pay-in ────────────────────────────────────────────────────────────
  ['stripe',        stripeProvider],        // Escenario A — principal
  ['fintoc',        fintocProvider],        // Escenario B — principal
  ['rampNetwork',   rampNetworkProvider],   // Fallback global (todos los escenarios)

  // ── Tránsito ──────────────────────────────────────────────────────────
  ['owlPay',        owlPayProvider],        // Escenario A — on-ramp institucional
  ['stellar',       stellarProvider],       // Todos los escenarios — autopista core

  // ── Pay-out / Off-ramp ────────────────────────────────────────────────
  ['anchorBolivia', anchorBoliviaProvider], // Escenario C — principal
  ['vitaWallet',    vitaWalletProvider],    // Escenario C fallback / Escenario D principal
]);

export default {
  /** @param {string} id @returns {PaymentProvider|null} */
  get: (id) => registry.get(id) ?? null,

  /** @param {string} id @returns {boolean} */
  has: (id) => registry.has(id),

  /** @returns {string[]} IDs de todos los proveedores registrados */
  list: () => [...registry.keys()],
};
