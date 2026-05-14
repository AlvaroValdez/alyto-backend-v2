/**
 * inspect-harbor-eu-schema.js
 *
 * Llama a Harbor para obtener el JSON Schema REAL de SEPA EU.
 * No adivina — lee lo que Harbor exige.
 *
 * Uso: node --env-file=.env scripts/inspect-harbor-eu-schema.js
 */

import { createQuote, getRequirementsSchema } from '../src/services/owlPayService.js';

const CUSTOMER_UUID = process.env.OWLPAY_CUSTOMER_UUID_SRL;

if (!CUSTOMER_UUID) {
  console.error('OWLPAY_CUSTOMER_UUID_SRL no configurada');
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('Harbor EU/SEPA — Schema Inspection');
console.log('═══════════════════════════════════════════════════════════════\n');

// ── Step 1: Crear quote para EU/EUR ────────────────────────────────────────
console.log('→ Creando quote: 100 USDC → EUR (DE)...');
const quote = await createQuote({
  source_amount:              100,
  destination_country:        'DE',  // Harbor no acepta 'EU' como country
  destination_currency:       'EUR',
  destination_payment_method: 'bank_transfer',
  source_chain:               process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
  customer_uuid:              CUSTOMER_UUID,
});

const quotes = Array.isArray(quote.data) ? quote.data : [quote.data ?? quote];
console.log(`\n✅ ${quotes.length} método(s) disponibles:`);
quotes.forEach(q => {
  console.log(`   - ${q.payment_method} | rate ${q.exchange_rate} | dest ${q.destination_amount} ${q.destination?.asset ?? 'EUR'}`);
});

// ── Step 2: Para cada quote, obtener el schema de requirements ─────────────
for (const q of quotes) {
  const quoteId = q.id ?? q.quote_id;
  console.log(`\n───────────────────────────────────────────────────────────────`);
  console.log(`Schema para método: ${q.payment_method} (quote ${quoteId.slice(0, 24)}...)`);
  console.log(`───────────────────────────────────────────────────────────────`);

  try {
    const schemaResponse = await getRequirementsSchema(quoteId);
    console.log(JSON.stringify(schemaResponse, null, 2));
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
  }
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('Inspección completa.');
console.log('═══════════════════════════════════════════════════════════════');
process.exit(0);
