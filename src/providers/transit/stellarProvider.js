/**
 * stellarProvider.js — Autopista Core de Tránsito (Todos los escenarios)
 *
 * REGLAS OBLIGATORIAS (Stellar_Integration_Alyto):
 *  - Fee Bump obligatorio en toda transacción de usuario final
 *  - Verificar trustline del destino antes de enviar activos no-XLM
 *  - Secret keys exclusivamente desde process.env — NUNCA hardcodeados
 *
 * Ver skill Stellar_Integration_Alyto para implementación completa.
 */
import { Horizon, Networks, Asset } from '@stellar/stellar-sdk';

export default {
  id:    'stellar',
  stage: 'transit',

  async execute({ amount, currency, stellarDestAddress, userId }) {
    const network = process.env.STELLAR_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;

    const server = new Horizon.Server(process.env.STELLAR_HORIZON_URL);

    // TODO (Stellar_Integration_Alyto):
    //  1. Verificar trustline del destino para el asset
    //  2. Construir transaction (Payment operation)
    //  3. Envolver en Fee Bump Transaction (fee pagado por cuenta corporativa)
    //  4. Firmar con clave de entidad operadora (desde process.env)
    //  5. Submit y retornar { txid: result.hash }

    throw new Error('stellarProvider: implementación completa en Stellar_Integration_Alyto');
  },

  async healthCheck() {
    try {
      const server = new Horizon.Server(process.env.STELLAR_HORIZON_URL);
      await server.ledgers().limit(1).call();
      return true;
    } catch {
      return false;
    }
  },
};
