/**
 * rampNetworkProvider.js — Fallback Global de Pay-in
 *
 * Ramp Network es un SDK de frontend (on-ramp fiat→crypto). Este provider
 * genera la URL de la hosted page de Ramp para que el frontend redirija al
 * usuario. No hay llamada server-side — la transacción la procesa Ramp
 * directamente con el usuario.
 *
 * Requiere: RAMP_API_KEY en .env
 * Asset objetivo: STELLAR_USDC (on-ramp a USDC en red Stellar)
 *
 * Documentación: https://docs.ramp.network/configuration
 */

const RAMP_HOSTED_URL = 'https://app.ramp.network/';

export default {
  id:    'rampNetwork',
  stage: 'payin',

  /**
   * @param {{ amount: number, currency: string, userId: string }} payload
   * @returns {{ widgetUrl: string, provider: string }}
   */
  async execute({ amount, currency = 'USD', userId }) {
    const apiKey = process.env.RAMP_API_KEY;
    if (!apiKey) throw new Error('rampNetworkProvider: RAMP_API_KEY no configurada.');

    const params = new URLSearchParams({
      apiKey,
      swapAsset:      'STELLAR_USDC',
      fiatValue:      String(Math.round(amount)),
      fiatCurrency:   currency.toUpperCase(),
      // hostLogoUrl y hostAppName pueden configurarse via env
      hostLogoUrl:    process.env.RAMP_HOST_LOGO_URL  ?? 'https://alyto.app/logo.png',
      hostAppName:    process.env.RAMP_HOST_APP_NAME  ?? 'Alyto',
      containerNode:  '',   // vacío = hosted page (no widget embebido)
    });

    return {
      widgetUrl: `${RAMP_HOSTED_URL}?${params.toString()}`,
      provider:  'rampNetwork',
    };
  },

  async healthCheck() {
    return !!(process.env.RAMP_API_KEY);
  },
};
