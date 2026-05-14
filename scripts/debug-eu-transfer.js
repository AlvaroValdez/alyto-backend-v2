/**
 * debug-eu-transfer.js
 *
 * Reproduce el flujo de transfer EU SEPA paso a paso, capturando
 * la respuesta completa de Harbor en cada paso. Útil para diagnosticar
 * errores 3004 ("Failed to create withdrawal order") que no son schema
 * sino compliance, banco corresponsal, o estado del customer.
 *
 * Uso: node --env-file=.env scripts/debug-eu-transfer.js
 */

import { createQuote, getRequirementsSchema, createTransfer, getCustomerUuid } from '../src/services/owlPayService.js';

const CUSTOMER_UUID = getCustomerUuid();
const SOURCE_ADDRESS = process.env.STELLAR_SRL_PUBLIC_KEY
  || process.env.STELLAR_MASTER_PUBLIC
  || 'GDA46XONBJOTZSONYXK6ZLI2QTSHC3ZI4F66H2A5J2V5OW6RU65NOITS';

if (!CUSTOMER_UUID) {
  console.error('❌ Customer UUID no configurado');
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('Debug EU SEPA Transfer — full flow');
console.log('═══════════════════════════════════════════════════════════════');
console.log('Customer UUID:', CUSTOMER_UUID.slice(0, 16) + '...');
console.log('Stellar src:  ', SOURCE_ADDRESS.slice(0, 8) + '...');

// ── STEP 1: Quote ───────────────────────────────────────────────────────────
console.log('\n→ Step 1: Crear quote EU SEPA (100 USDC → EUR)');
const quote = await createQuote({
  source_amount:              100,
  destination_country:        'DE',   // Harbor no acepta 'EU'
  destination_currency:       'EUR',
  destination_payment_method: 'bank_transfer',
  source_chain:               process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
  customer_uuid:              CUSTOMER_UUID,
});

const quotes = Array.isArray(quote.data) ? quote.data : [quote.data ?? quote];
const sepaQuote = quotes.find(q => q.payment_method === 'SEPA') ?? quotes[0];
console.log('  ✅ Quote ID:', sepaQuote.id ?? sepaQuote.quote_id);
console.log('     Method:  ', sepaQuote.payment_method);
console.log('     Rate:    ', sepaQuote.exchange_rate);
console.log('     Dest amt:', sepaQuote.destination_amount, sepaQuote.destination?.asset ?? sepaQuote.destination_currency);
console.log('     Expires: ', sepaQuote.expires_at ?? sepaQuote.crypto_funds_settlement_expire_date);

// ── STEP 2: Get requirements schema ─────────────────────────────────────────
console.log('\n→ Step 2: Get requirements schema');
const schemaResp = await getRequirementsSchema(sepaQuote.id ?? sepaQuote.quote_id);
const schema = schemaResp.schema ?? schemaResp;
console.log('  ✅ Schema title:', schema.title);

// ── STEP 3: Crear transfer con payload mínimo válido ─────────────────────────
console.log('\n→ Step 3: Crear transfer (Hans Müller test data)');

const beneficiary_info = {
  beneficiary_name: 'Hans Müller',
  beneficiary_address: {
    street:      'Hauptstraße 15',
    city:        'Berlín',
    country:     'DE',
    postal_code: '10115',
  },
};

const payout_instrument = {
  account_holder_name: 'Hans Müller',
  account_number:      'DE89370400440532013000',
  swift_code:          'COBADEFFXXX',  // BIC de Commerzbank — testing si SEPA realmente lo requiere
};

console.log('  beneficiary_info:', JSON.stringify(beneficiary_info, null, 2));
console.log('  payout_instrument:', JSON.stringify(payout_instrument, null, 2));

try {
  const transfer = await createTransfer({
    quote_id:                  sepaQuote.id ?? sepaQuote.quote_id,
    on_behalf_of:              CUSTOMER_UUID,
    application_transfer_uuid: `ALY-DEBUG-${Date.now()}`,
    source_address:            SOURCE_ADDRESS,
    beneficiary_info,
    payout_instrument,
    transfer_purpose:          'FAMILY_MAINTENANCE',
    is_self_transfer:          false,
  });

  console.log('\n✅ Transfer creado!');
  console.log(JSON.stringify(transfer, null, 2));
} catch (err) {
  console.error('\n❌ Transfer falló:');
  console.error('   Status:    ', err.status);
  console.error('   Code:      ', err.code ?? err.data?.code);
  console.error('   Message:   ', err.message);
  console.error('   Full data: ', JSON.stringify(err.data, null, 2));
  console.error('\n   Stack:', err.stack);
}

process.exit(0);
