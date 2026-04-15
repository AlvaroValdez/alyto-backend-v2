/**
 * owlPayProvider.js — OwlPay Harbor v2 off-ramp (SRL/LLC)
 * Puente USDC → fiat local vía Harbor. Ver OWLPAY_API_KEY en .env
 * Docs: https://harbor-developers.owlpay.com/docs/overview
 *
 * Esta clase es thin-wrapper del nuevo flujo v2: getHarborQuote →
 * createHarborTransfer. El envío de USDC a la instruction_address se delega
 * al dispatchPayout de ipnController (que controla el OWLPAY_USDC_SEND_ENABLED
 * flag). Este provider se mantiene por si el registry necesita invocar
 * Harbor fuera del dispatcher principal.
 */
import {
  getHarborQuote,
  createHarborTransfer,
  getCustomerUuid,
} from '../../services/owlPayService.js';

export default {
  id:    'owlPay',
  stage: 'transit',

  async execute(transaction, corridor) {
    const entity       = transaction.legalEntity ?? corridor?.legalEntity;
    const customerUuid = getCustomerUuid(entity);

    const quote = await getHarborQuote({
      sourceAmount:      transaction.digitalAssetAmount ?? transaction.originAmount,
      sourceCurrency:    'USDC',
      sourceChain:       process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
      destCountry:       corridor?.destinationCountry  ?? transaction.destinationCountry,
      destCurrency:      corridor?.destinationCurrency ?? transaction.destinationCurrency,
      customerUuid,
      commissionPercent: corridor?.alytoCSpread ?? 0.5,
    });

    const transfer = await createHarborTransfer({
      quoteId:            quote.quoteId,
      customerUuid,
      alytoTransactionId: transaction.alytoTransactionId,
      sourceAddress:      process.env.STELLAR_SRL_PUBLIC_KEY ?? process.env.STELLAR_LLC_PUBLIC_KEY,
      beneficiary:        transaction.beneficiaryDetails ?? transaction.beneficiary,
      destCountry:        corridor?.destinationCountry  ?? transaction.destinationCountry,
      destCurrency:       corridor?.destinationCurrency ?? transaction.destinationCurrency,
    });

    return { quote, transfer };
  },

  async healthCheck() {
    // Harbor no expone un endpoint /health público — asumir healthy.
    // Errores reales se detectan en execute() y activan fallbackPayoutMethod.
    return true;
  },
};
