/**
 * transactionRouter.js — Cerebro de Enrutamiento de Alyto
 *
 * Aplica las reglas de jurisdicción y retorna un objeto RouteDefinition
 * que describe QUÉ proveedores usar en qué orden, sin ejecutar nada.
 * Separar la decisión de la ejecución permite testear reglas de negocio
 * de forma completamente aislada.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  TABLA DE DECISIÓN — Prioridad descendente                          │
 * │─────────────────────────────────────────────────────────────────────│
 * │  P1  corporativo ó origen=US  → LLC  │ Stripe → OwlPay → Stellar   │
 * │  P2  origen=CL               → SpA  │ Fintoc → Stellar             │
 * │  P3  destino=BO              → SRL  │ Stellar → Anchor Bolivia     │
 * │  P4  destino=LatAm           → LLC  │ Stellar → Vita Wallet        │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * NOTA DE COMPLIANCE: Terminología prohibida ausente.
 * Usar siempre: crossBorderPayment, payin, payout, liquidación.
 */

// Países de LatAm cubiertos por el Escenario D (excluye BO y CL, que tienen escenarios propios)
const LATAM_COUNTRIES = new Set([
  'AR', 'BR', 'CO', 'PE', 'EC', 'PY', 'UY', 'VE',
  'MX', 'CR', 'PA', 'GT', 'HN', 'SV', 'NI', 'DO', 'CU',
]);

/**
 * Resuelve la ruta de pago según las reglas de jurisdicción de AV Finance.
 *
 * @param {PaymentRequestDTO} request
 * @returns {RouteDefinition}
 *
 * @typedef {Object} PaymentRequestDTO
 * @property {string}             userId               - ID interno Alyto
 * @property {string}             originCountry        - ISO 3166-1 alpha-2 (ej. 'CL', 'US', 'BO')
 * @property {string}             destinationCountry   - ISO 3166-1 alpha-2
 * @property {'personal'|'corporate'} clientType
 * @property {number}             amount               - Monto en moneda de origen
 * @property {string}             currency             - ISO 4217 (ej. 'USD', 'CLP', 'BOB')
 * @property {string}             [stellarDestAddress] - Stellar public key del destino
 * @property {object}             [kycData]            - Datos KYC/KYB del usuario
 * @property {object}             [boliviaComplianceData] - Requerido si destino=BO
 *
 * @typedef {Object} RouteDefinition
 * @property {'A'|'B'|'C'|'D'}   scenario
 * @property {string}             entity               - Entidad legal AV Finance operadora
 * @property {string[]}           payinProviders       - En orden de preferencia (primero = principal)
 * @property {string[]}           transitProviders     - En orden de preferencia
 * @property {string[]}           payoutProviders      - En orden de preferencia
 * @property {boolean}            requiresBoliviaCompliance
 */
export function resolveRoute({ originCountry, destinationCountry, clientType }) {

  // ── Escenario A: Institucional / Global ──────────────────────────────────
  // Condición: cliente corporativo (KYB) O país de origen = EE.UU.
  // Entidad operadora: AV Finance LLC (Delaware)
  // Flujo: Stripe → OwlPay → Stellar Network → [Destino]
  if (clientType === 'corporate' || originCountry === 'US') {
    return {
      scenario:                  'A',
      entity:                    'AV Finance LLC',
      payinProviders:            ['stripe', 'rampNetwork'],   // rampNetwork = fallback
      transitProviders:          ['owlPay', 'stellar'],       // owlPay on-ramp → stellar tránsito
      payoutProviders:           [],
      requiresBoliviaCompliance: false,
    };
  }

  // ── Escenario B: Corredor Local Chile ────────────────────────────────────
  // Condición: país de origen de fondos = Chile
  // Entidad operadora: AV Finance SpA (Antofagasta)
  // Flujo: Fintoc (Open Banking A2A) → Stellar Network → [Destino]
  if (originCountry === 'CL') {
    return {
      scenario:                  'B',
      entity:                    'AV Finance SpA',
      payinProviders:            ['fintoc', 'rampNetwork'],   // rampNetwork = fallback
      transitProviders:          ['stellar'],
      payoutProviders:           [],
      requiresBoliviaCompliance: false,
    };
  }

  // ── Escenario C: Corredor Local Bolivia ──────────────────────────────────
  // Condición: país de destino = Bolivia
  // Entidad operadora: AV Finance SRL (licencia ETF/PSAV en trámite)
  // Flujo: Stellar Network → Anchor Manual Bolivia → PDF Comprobante Oficial
  // IMPORTANTE: Activa Compliance_Bolivia_Alyto automáticamente
  if (destinationCountry === 'BO') {
    return {
      scenario:                  'C',
      entity:                    'AV Finance SRL',
      payinProviders:            [],
      transitProviders:          ['stellar'],
      payoutProviders:           ['anchorBolivia', 'vitaWallet'], // vitaWallet = fallback
      requiresBoliviaCompliance: true,
    };
  }

  // ── Escenario D: LatAm General ───────────────────────────────────────────
  // Condición: destino en LatAm (excluye BO y CL con escenarios propios)
  // Entidad operadora: AV Finance LLC (por defecto para LatAm no cubierto)
  // Flujo: Stellar Network → Vita Wallet → [Cliente LatAm]
  if (LATAM_COUNTRIES.has(destinationCountry)) {
    return {
      scenario:                  'D',
      entity:                    'AV Finance LLC',
      payinProviders:            [],
      transitProviders:          ['stellar'],
      payoutProviders:           ['vitaWallet', 'rampNetwork'], // rampNetwork = fallback
      requiresBoliviaCompliance: false,
    };
  }

  // ── Sin cobertura ────────────────────────────────────────────────────────
  throw new Error(
    `[Alyto Router] Sin corredor disponible: origen=${originCountry} / destino=${destinationCountry}`,
  );
}
