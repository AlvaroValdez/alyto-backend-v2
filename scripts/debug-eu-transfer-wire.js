/**
 * debug-eu-transfer-wire.js
 *
 * Prueba con WIRE method para EU (en vez de SEPA) para validar si el
 * bug de Harbor es específico de SEPA o afecta también a WIRE.
 *
 * Uso: node --env-file=.env scripts/debug-eu-transfer-wire.js
 */

import { createQuote, createTransfer, getCustomerUuid } from '../src/services/owlPayService.js';

const CUSTOMER_UUID  = getCustomerUuid();
const SOURCE_ADDRESS = process.env.STELLAR_SRL_PUBLIC_KEY
  || 'GDA46XONBJOTZSONYXK6ZLI2QTSHC3ZI4F66H2A5J2V5OW6RU65NOITS';

console.log('Customer UUID:', CUSTOMER_UUID.slice(0, 16) + '...');
console.log('Stellar src:  ', SOURCE_ADDRESS.slice(0, 8) + '...');

// ── Quote ────────────────────────────────────────────────────────────────────
const quote = await createQuote({
  source_amount:              100,
  destination_country:        'DE',
  destination_currency:       'EUR',
  destination_payment_method: 'bank_transfer',
  source_chain:               process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
  customer_uuid:              CUSTOMER_UUID,
});

const quotes = Array.isArray(quote.data) ? quote.data : [quote.data ?? quote];
const wireQuote = quotes.find(q => q.payment_method === 'WIRE');

if (!wireQuote) {
  console.error('❌ No se encontró WIRE quote');
  process.exit(1);
}

console.log('\n✅ WIRE quote:', wireQuote.id ?? wireQuote.quote_id);
console.log('   Rate:    ', wireQuote.exchange_rate);
console.log('   Dest amt:', wireQuote.destination_amount, 'EUR');

// ── Transfer WIRE ────────────────────────────────────────────────────────────
const payload = {
  quote_id:                  wireQuote.id ?? wireQuote.quote_id,
  on_behalf_of:              CUSTOMER_UUID,
  application_transfer_uuid: `ALY-DEBUG-WIRE-${Date.now()}`,
  source_address:            SOURCE_ADDRESS,
  beneficiary_info: {
    beneficiary_name: 'Hans Müller',
    beneficiary_address: {
      street:      'Hauptstraße 15',
      city:        'Berlín',
      country:     'DE',
      postal_code: '10115',
    },
  },
  payout_instrument: {
    account_holder_name: 'Hans Müller',
    bank_name:           'Commerzbank',
    account_number:      'DE89370400440532013000',
    swift_code:          'COBADEFFXXX',
  },
  transfer_purpose: 'FAMILY_MAINTENANCE',
  is_self_transfer: false,
};

console.log('\n→ Creando transfer WIRE...');
try {
  const transfer = await createTransfer(payload);
  console.log('\n✅ Transfer WIRE creado exitosamente!');
  const td = transfer.data ?? transfer;
  console.log('   ID:    ', td.uuid ?? td.id);
  console.log('   Status:', td.status);
  const instr = td.transfer_instructions ?? td.source?.transfer_instructions ?? {};
  console.log('   Instruction address:', instr.instruction_address ?? '(not yet)');
  console.log('   Instruction chain:  ', instr.chain ?? '(not yet)');
} catch (err) {
  console.error('\n❌ WIRE también falla:');
  console.error('   Code:    ', err.code ?? err.data?.code);
  console.error('   Message: ', err.message);
  console.error('   Details: ', JSON.stringify(err.data, null, 2));
}

process.exit(0);
