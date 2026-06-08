/**
 * stripeProvider.js — Pay-in Escenario A (AV Finance LLC)
 *
 * Crea un Stripe PaymentIntent y devuelve el clientSecret para que
 * el frontend complete el pago con Stripe Elements o Payment Link.
 *
 * COMPLIANCE: metadata.category = 'cross_border_payment' — NUNCA 'remittance'.
 *
 * Este provider es consumido por paymentOrchestrator → executeWithFallback.
 * Escenario A (corporate/US): stripe → rampNetwork (fallback).
 */
import Stripe from 'stripe';

let _stripe;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// Stripe trata estas monedas como enteras (sin centavos)
const ZERO_DECIMAL_CURRENCIES = new Set(['CLP', 'JPY', 'KRW', 'VND', 'BIF', 'GNF', 'MGA', 'PYG', 'RWF', 'UGX', 'XAF', 'XOF', 'XPF']);

export default {
  id:    'stripe',
  stage: 'payin',

  /**
   * @param {{ amount: number, currency: string, userId: string }} payload
   * @returns {{ paymentIntentId: string, clientSecret: string, status: string, amount: number, currency: string }}
   */
  async execute({ amount, currency = 'USD', userId }) {
    const stripe     = getStripe();
    const currUpper  = currency.toUpperCase();
    const stripeAmount = ZERO_DECIMAL_CURRENCIES.has(currUpper)
      ? Math.round(amount)
      : Math.round(amount * 100);

    const intent = await stripe.paymentIntents.create({
      amount:   stripeAmount,
      currency: currUpper.toLowerCase(),
      metadata: {
        userId:   String(userId),
        category: 'cross_border_payment',  // COMPLIANCE — no usar 'remittance'
      },
    });

    return {
      paymentIntentId: intent.id,
      clientSecret:    intent.client_secret,
      status:          intent.status,
      amount:          intent.amount,
      currency:        intent.currency,
    };
  },

  async healthCheck() {
    return !!(process.env.STRIPE_SECRET_KEY);
  },
};
