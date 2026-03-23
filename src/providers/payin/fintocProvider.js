/**
 * fintocProvider.js — Pay-in Escenario B (AV Finance SpA — Chile)
 * Open Banking A2A. Ver FINTOC_SECRET_KEY en .env
 */
export default {
  id:    'fintoc',
  stage: 'payin',

  async execute({ amount, currency, userId }) {
    // TODO: Fintoc Payments API — iniciación de pago cuenta a cuenta (CLP)
    throw new Error('fintocProvider: integración real pendiente');
  },

  async healthCheck() {
    return false;
  },
};
