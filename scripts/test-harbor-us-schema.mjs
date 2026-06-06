/**
 * test-harbor-us-schema.mjs — Harbor US: obtiene quote + requirements schema
 * para ver el enum exacto que Harbor espera para state_province en US.
 *
 * Run: node --env-file=.env scripts/test-harbor-us-schema.mjs
 */
import { createQuote, getRequirementsSchema } from '../src/services/owlPayService.js';

const CUSTOMER_UUID = process.env.OWLPAY_CUSTOMER_UUID_SRL
  ?? process.env.OWLPAY_CUSTOMER_UUID;

if (!CUSTOMER_UUID) {
  console.error('❌ OWLPAY_CUSTOMER_UUID_SRL (o OWLPAY_CUSTOMER_UUID) no configurado');
  process.exit(1);
}

console.log('🔍 Harbor US schema check');
console.log('   Customer UUID:', CUSTOMER_UUID.slice(0, 16) + '...');
console.log('   API:', process.env.OWLPAY_BASE_URL ?? process.env.OWLPAY_API_URL);
console.log();

// Step 1: quote para US ACH_PUSH
const quote = await createQuote({
  source_amount:             40,
  destination_country:       'US',
  destination_currency:      'USD',
  destination_payment_method: 'ACH_PUSH',
  source_chain:              process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
  customer_uuid:             CUSTOMER_UUID,
}).catch(err => { console.error('❌ Quote falló:', err.message); process.exit(1); });

const quoteData = Array.isArray(quote.data) ? quote.data[0] : (quote.data ?? quote);
const quoteId   = quoteData.id ?? quoteData.quote_id;
console.log('✅ Quote OK:', quoteId);
console.log('   Method:', quoteData.payment_method, '| Rate:', quoteData.exchange_rate);
console.log();

// Step 2: requirements schema — aquí veremos el enum de state_province
const schema = await getRequirementsSchema(quoteId)
  .catch(err => { console.error('❌ Requirements falló:', err.message); process.exit(1); });

console.log('✅ Schema OK');
console.log();

// Buscar state_province en el schema
const schemaStr = JSON.stringify(schema, null, 2);

// Imprimir schema completo de beneficiary_address si existe
const findInSchema = (obj, path = '') => {
  if (typeof obj !== 'object' || obj === null) return;
  for (const [k, v] of Object.entries(obj)) {
    const fullPath = path ? `${path}.${k}` : k;
    if (k === 'state_province' || fullPath.includes('state_province')) {
      console.log(`📍 Encontrado en: ${fullPath}`);
      console.log(JSON.stringify(v, null, 2));
      console.log();
    }
    if (k === 'beneficiary_address') {
      console.log(`📍 beneficiary_address schema:`);
      console.log(JSON.stringify(v, null, 2));
      console.log();
    }
    if (typeof v === 'object') findInSchema(v, fullPath);
  }
};

findInSchema(schema);
console.log('--- Schema completo ---');
console.log(schemaStr.slice(0, 3000));
