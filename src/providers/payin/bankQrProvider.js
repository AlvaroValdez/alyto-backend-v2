/**
 * bankQrProvider.js — Provider genérico de payin via QR bancario boliviano
 *
 * Implementa la interfaz de provider del fallbackExecutor para el stage 'payin'.
 * Funciona con cualquier banco registrado en bankQrRegistry.
 *
 * createBankQrProvider(bankId) devuelve un provider listo para registrar.
 * Las instancias pre-construidas (becQrProvider) son las que van al providerRegistry.
 *
 * Patrón para agregar banco nuevo al registry:
 *   export const bnbQrProvider = createBankQrProvider('bnb');
 *   // + registrar en providerRegistry.js
 */

import { getBankQrService } from '../../services/bankQr/bankQrRegistry.js';

/**
 * @param {string} bankId — ID del banco ('bec', 'bnb', ...)
 */
export function createBankQrProvider(bankId) {
  return {
    id:     `bankQr:${bankId}`,
    stage:  'payin',
    bankId,

    /**
     * Genera un QR de cobro bancario.
     *
     * @param {{ transactionId, amount, currency, description, dueDate }} payload
     * @returns {{ qrId: string, qrImage: string }}
     */
    async execute({ transactionId, amount, currency = 'BOB', description, dueDate }) {
      const svc = getBankQrService(bankId);
      return svc.generateQR({ transactionId, amount, currency, description, dueDate });
    },

    async cancel(qrId) {
      const svc = getBankQrService(bankId);
      return svc.cancelQR(qrId);
    },

    async healthCheck() {
      const svc = getBankQrService(bankId);
      return svc.isAvailable();
    },
  };
}

// ── Instancias pre-construidas por banco ──────────────────────────────────────
export const becQrProvider = createBankQrProvider('bec');
