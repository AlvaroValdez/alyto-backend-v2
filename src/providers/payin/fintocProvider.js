/**
 * fintocProvider.js — Pay-in Escenario B (AV Finance SpA — Chile)
 *
 * Crea un Fintoc Checkout Session (Open Banking A2A) y devuelve la URL
 * de pago para que el frontend redirija al usuario.
 *
 * Este provider es consumido por paymentOrchestrator → executeWithFallback.
 * El flujo directo de producción usa initiateFintocPayin() en paymentController.
 */
import { createWidgetLink } from '../../services/fintocService.js';

export default {
  id:    'fintoc',
  stage: 'payin',

  /**
   * @param {{ amount: number, currency: string, userId: string }} payload
   * @returns {{ checkoutSessionId: string, checkoutUrl: string, amount: number, currency: string }}
   */
  async execute({ amount, currency = 'CLP', userId }) {
    const session = await createWidgetLink({
      amount,
      currency,
      metadata: { userId: String(userId), source: 'orchestrator' },
    });

    return {
      checkoutSessionId: session.id,
      checkoutUrl:       session.url,
      amount:            session.amount,
      currency:          session.currency,
    };
  },

  async healthCheck() {
    return !!(process.env.FINTOC_SECRET_KEY);
  },
};
