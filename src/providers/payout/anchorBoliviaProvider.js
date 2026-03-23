/**
 * anchorBoliviaProvider.js — Off-ramp Escenario C (AV Finance SRL)
 * Anchor Manual Bolivia. Tras el payout, fallbackExecutor invoca
 * Compliance_Bolivia_Alyto para generar el Comprobante Oficial de Transacción.
 */
export default {
  id:    'anchorBolivia',
  stage: 'payout',

  async execute({ amount, destinationCountry, userId, stellarTxid }) {
    // TODO: Lógica de Anchor Manual Bolivia
    // Incluye: verificación KYC (NIT/CI), límites por licencia ETF/PSAV,
    // registro en BD con stellarTxid para trazabilidad del comprobante
    throw new Error('anchorBoliviaProvider: integración real pendiente');
  },

  async healthCheck() {
    return false;
  },
};
