/**
 * rampNetworkProvider.js — Fallback Global de Pay-in
 * Usado cuando Stripe (A) o Fintoc (B) fallan.
 */
export default {
  id:    'rampNetwork',
  stage: 'payin',

  async execute({ amount, currency, userId }) {
    // TODO: Ramp Network On-Ramp SDK
    throw new Error('rampNetworkProvider: integración real pendiente');
  },

  async healthCheck() {
    return false;
  },
};
