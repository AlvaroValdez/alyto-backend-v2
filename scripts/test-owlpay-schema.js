/**
 * test-owlpay-schema.js — Harbor CN E2E: quote → requirements → transfer
 * Run: OWLPAY_CUSTOMER_UUID_SRL=<uuid> node --env-file=.env scripts/test-owlpay-schema.js
 */
import { createQuote, getRequirementsSchema, createTransfer } from '../src/services/owlPayService.js';
import { buildPayoutInstrument } from '../src/services/owlPayService.js';

const CUSTOMER_UUID = process.env.OWLPAY_CUSTOMER_UUID_SRL
  ?? 'cus_REDACTED';

// Use || not ?? — empty string in .env must be treated as falsy
const SOURCE_ADDRESS = process.env.STELLAR_MASTER_PUBLIC
  || process.env.STELLAR_SRL_PUBLIC_KEY
  || 'GDA46XONBJOTZSONYXK6ZLI2QTSHC3ZI4F66H2A5J2V5OW6RU65NOITS';

// ── Step 1: Quote ──────────────────────────────────────────────────────────────
const quote = await createQuote({
  source_amount: 32,
  destination_country: 'CN',
  destination_currency: 'CNY',
  destination_payment_method: 'bank_transfer',
  source_chain: 'stellar',
  customer_uuid: CUSTOMER_UUID,
});

const quoteData = quote.data?.[0] ?? quote.data ?? quote;
const quoteId   = quoteData.id ?? quoteData.quote_id;
console.log('✅ Quote OK:', quoteId);
console.log('   Rate:', quoteData.exchange_rate, '| Dest:', quoteData.destination_amount, quoteData.destination_currency);

// ── Step 2: Requirements schema ────────────────────────────────────────────────
const schema = await getRequirementsSchema(quoteId);
console.log('\n✅ Schema OK — top-level required:', schema.required);

// ── Step 3: Build beneficiary (fake CN data for sandbox) ───────────────────────
const fakeBeneficiary = {
  firstName:      'Wei',
  lastName:       'Zhang',
  account_holder_name: 'Zhang Wei',
  bank_name:      'Industrial and Commercial Bank of China',
  account_number: '6222021001234567890',
  swift_code:     'ICBKCNBJXXX',
  street:         '123 Nanjing Road',
  city:           'Shanghai',
  state_province: 'SH',
  postal_code:    '200001',
};

const dest = 'CN';
const payout_instrument = buildPayoutInstrument(fakeBeneficiary, dest);
console.log('\n✅ payout_instrument:', JSON.stringify(payout_instrument, null, 2));

const beneficiary_info = {
  beneficiary_name: `${fakeBeneficiary.firstName} ${fakeBeneficiary.lastName}`,
  beneficiary_address: {
    street:         fakeBeneficiary.street,
    country:        dest,
    city:           fakeBeneficiary.city,
    state_province: fakeBeneficiary.state_province,
    postal_code:    fakeBeneficiary.postal_code,
  },
};

// ── Step 4: Create transfer ────────────────────────────────────────────────────
console.log('\n→ Creating transfer with source_address:', SOURCE_ADDRESS.slice(0, 8) + '...');

try {
  const transfer = await createTransfer({
    quote_id:                  quoteId,
    on_behalf_of:              CUSTOMER_UUID,
    application_transfer_uuid: `ALY-TEST-${Date.now()}`,
    source_address:            SOURCE_ADDRESS,
    beneficiary_info,
    payout_instrument,
    transfer_purpose:          'FAMILY_MAINTENANCE',
    is_self_transfer:          false,
  });

  const td = transfer.data ?? transfer;
  console.log('\n✅ Transfer created!');
  console.log('   ID:      ', td.uuid ?? td.id);
  console.log('   Status:  ', td.status);
  const instr = td.transfer_instructions ?? td.source?.transfer_instructions ?? {};
  console.log('   Instruction address:', instr.instruction_address ?? instr.address ?? '(not yet)');
  console.log('   Instruction memo:   ', instr.instruction_memo   ?? instr.memo   ?? '(not yet)');
  console.log('\nFull response:', JSON.stringify(td, null, 2));
} catch (err) {
  console.error('\n❌ Transfer failed:', err.message);
  if (err.data) console.error('   Harbor error data:', JSON.stringify(err.data, null, 2));
}
