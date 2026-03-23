/**
 * stripeProvider.js — Pay-in Escenario A (AV Finance LLC)
 * Integración real pendiente. Ver STRIPE_SECRET_KEY en .env
 */
export default {
  id:    'stripe',
  stage: 'payin',

  async execute({ amount, currency, userId }) {
    // TODO: Stripe PaymentIntents API
    // COMPLIANCE: No usar categoría 'remittance' en metadata de Stripe.
    // Usar: { category: 'cross_border_payment' }
    throw new Error('stripeProvider: integración real pendiente');
  },

  async healthCheck() {
    return false;
  },
};
