/**
 * owlPayProvider.js — On-ramp Institucional Escenario A (AV Finance LLC)
 * Puente fiat → USDC sobre Stellar. Ver OWLPAY_API_KEY en .env
 * Docs: https://harbor-developers.owlpay.com/docs/overview
 */
export default {
  id:    'owlPay',
  stage: 'transit',

  async execute({ amount, currency, stellarDestAddress, userId }) {
    // TODO: OwlPay Harbor API — On-ramp y liquidación B2B
    // Retorna { txid } con el hash de la transacción Stellar
    throw new Error('owlPayProvider: integración real pendiente');
  },

  async healthCheck() {
    return false;
  },
};
