/**
 * vitaWalletProvider.js — Off-ramp LatAm (Escenario D / Fallback Escenario C)
 *
 * Implementación del provider para el fallbackExecutor.
 * Usa vitaWalletService como cliente HTTP.
 *
 * Escenario D: LatAm General → off-ramp vía Vita Wallet
 * Fallback C:  Bolivia → si anchorBolivia falla, usa Vita Wallet
 */

import { createPayout, getWithdrawalRules } from '../../services/vitaWalletService.js';

export default {
  id:    'vitaWallet',
  stage: 'payout',

  /**
   * Ejecuta un payout vía Vita Wallet Business API.
   *
   * @param {object} payload
   * @param {number} payload.amount
   * @param {string} payload.destinationCountry  — ISO alpha-2
   * @param {string} payload.userId
   * @param {string} payload.stellarTxid
   * @param {object} payload.beneficiary          — Datos del beneficiario
   * @param {object} [payload.bankData]           — Campos dinámicos bancarios del país
   * @returns {Promise<{ transactionId: string, status: string }>}
   */
  async execute({ amount, destinationCountry, userId, stellarTxid, beneficiary = {}, bankData = {} }) {
    const order = `ALY-D-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    const result = await createPayout({
      country:  destinationCountry,
      currency: 'usd',
      amount,
      order,
      beneficiary_first_name:    beneficiary.firstName   ?? '',
      beneficiary_last_name:     beneficiary.lastName    ?? '',
      beneficiary_email:         beneficiary.email       ?? '',
      beneficiary_address:       beneficiary.address     ?? '',
      beneficiary_document_type: beneficiary.docType     ?? '',
      beneficiary_document_number: beneficiary.docNumber ?? '',
      purpose:          'ISSAVG',
      purpose_comentary: `Alyto cross-border payment | Stellar TXID: ${stellarTxid ?? 'N/A'}`,
      ...bankData,
    });

    return {
      transactionId: result?.data?.id ?? order,
      status:        result?.data?.attributes?.status ?? 'started',
      raw:           result,
    };
  },

  async healthCheck() {
    try {
      await getWithdrawalRules();
      return true;
    } catch {
      return false;
    }
  },
};
