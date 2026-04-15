/**
 * owlPayProvider.js — On-ramp Institucional Escenario A (AV Finance LLC)
 * Puente fiat → USDC sobre Stellar. Ver OWLPAY_API_KEY en .env
 * Docs: https://harbor-developers.owlpay.com/docs/overview
 *
 * Delegación: la lógica real vive en services/owlPayService.js. Este provider
 * solo adapta la interfaz del registry al contrato del servicio.
 */
import { createDisbursement } from '../../services/owlPayService.js';

export default {
  id:    'owlPay',
  stage: 'transit',

  async execute(transaction, corridor) {
    return createDisbursement({
      amount:              transaction.originAmount,
      legalEntity:         transaction.legalEntity ?? corridor?.legalEntity,
      corridorCode:        transaction.corridorId ?? corridor?.corridorId,
      alytoTransactionId:  transaction.alytoTransactionId,
      userId:              transaction.userId,
      beneficiary:         transaction.beneficiaryDetails ?? transaction.beneficiary,
      destinationCountry:  corridor?.destinationCountry  ?? transaction.destinationCountry,
      destinationCurrency: corridor?.destinationCurrency ?? transaction.destinationCurrency,
    });
  },

  async healthCheck() {
    // Harbor no expone un endpoint /health público — asumir healthy.
    // Errores reales se detectan en execute() y activan fallbackPayoutMethod.
    return true;
  },
};
