/**
 * stellarProvider.js — Proveedor de Tránsito Stellar (todos los escenarios)
 *
 * Integra stellarService.js con el orquestador de pagos vía providerRegistry.
 *
 * REGLAS OBLIGATORIAS (Stellar_Integration_Alyto):
 *  - Fee Bump obligatorio en toda transacción de usuario final
 *  - Verificar trustline del destino antes de enviar activos no-XLM
 *  - Secret keys exclusivamente desde process.env — NUNCA hardcodeados
 *  - legalEntity determina qué keypair corporativo firma la operación
 *
 * Mapa legalEntity → keypairs:
 *   SpA → STELLAR_SPA_PUBLIC_KEY / STELLAR_SPA_SECRET_KEY
 *   SRL → STELLAR_SRL_PUBLIC_KEY / STELLAR_SRL_SECRET_KEY
 *   LLC → STELLAR_LLC_PUBLIC_KEY / STELLAR_LLC_SECRET_KEY
 */

import {
  executeStellarPayment,
  getStellarUSDCBalance,
} from '../../services/stellarService.js';
import { horizonServer } from '../../config/stellar.js';

// Mapa entidad → { publicKeyEnv, secretKeyEnv }
const ENTITY_KEYPAIRS = {
  SpA: { publicKeyEnv: 'STELLAR_SPA_PUBLIC_KEY', secretKeyEnv: 'STELLAR_SPA_SECRET_KEY' },
  SRL: { publicKeyEnv: 'STELLAR_SRL_PUBLIC_KEY', secretKeyEnv: 'STELLAR_SRL_SECRET_KEY' },
  LLC: { publicKeyEnv: 'STELLAR_LLC_PUBLIC_KEY', secretKeyEnv: 'STELLAR_LLC_SECRET_KEY' },
};

export default {
  id:    'stellar',
  stage: 'transit',

  /**
   * Ejecuta un pago de tránsito via Stellar.
   *
   * @param {object} params
   * @param {number} params.amount             - Monto USDC a enviar
   * @param {string} params.currency           - 'USDC' (único asset activo)
   * @param {string} params.stellarDestAddress - Public key Stellar del destinatario
   * @param {string} params.userId             - ID del usuario (para trazabilidad)
   * @param {string} [params.legalEntity]      - 'SpA' | 'SRL' | 'LLC' (default: SpA)
   * @param {string} [params.memo]             - Memo para trazabilidad on-chain
   * @returns {Promise<{ txid: string, ledger: number }>}
   */
  async execute({ amount, currency = 'USDC', stellarDestAddress, userId, legalEntity = 'SpA', memo }) {
    if (!stellarDestAddress) {
      throw new Error('[stellarProvider] stellarDestAddress requerida');
    }
    if (!amount || amount <= 0) {
      throw new Error('[stellarProvider] amount debe ser positivo');
    }

    const entityKey = ENTITY_KEYPAIRS[legalEntity] ?? ENTITY_KEYPAIRS.SpA;
    const sourcePublicKey = process.env[entityKey.publicKeyEnv];

    if (!sourcePublicKey) {
      throw new Error(
        `[stellarProvider] ${entityKey.publicKeyEnv} no configurada para entidad ${legalEntity}. ` +
        'Verificar variables de entorno Stellar.',
      );
    }

    return executeStellarPayment({
      sourcePublicKey,
      destinationPublicKey: stellarDestAddress,
      amount:               String(amount),
      assetCode:            currency,
      signerSecretEnvKey:   entityKey.secretKeyEnv,
      memo,
    });
  },

  /**
   * Health check: verifica conectividad con Horizon y balance USDC de SRL.
   * Retorna true si Horizon responde, aunque el balance sea 0.
   */
  async healthCheck() {
    try {
      await horizonServer.ledgers().limit(1).call();

      // Check adicional: balance USDC SRL si está configurado
      const srlPublic = process.env.STELLAR_SRL_PUBLIC_KEY;
      if (srlPublic) {
        const balance = await getStellarUSDCBalance(srlPublic);
        const threshold = parseFloat(process.env.USDC_LOW_BALANCE_THRESHOLD ?? '100');
        if (balance < threshold) {
          console.warn(`[stellarProvider] ⚠️ Balance USDC SRL bajo: ${balance} USDC (umbral: ${threshold})`);
        }
      }

      return true;
    } catch {
      return false;
    }
  },
};
