/**
 * inspect-harbor-all-schemas.js
 *
 * Consulta el schema REAL de Harbor para cada país/método activo.
 * Compara los `required` y campos permitidos con lo que envía
 * buildPayoutInstrument / buildOwlPayBeneficiary actualmente.
 *
 * Uso: node --env-file=.env scripts/inspect-harbor-all-schemas.js
 *
 * Output:
 *   - Lista de métodos disponibles por país
 *   - Required fields de payout_instrument por método
 *   - Required fields de beneficiary_info y beneficiary_address
 *   - Si hay additionalProperties: false (schema estricto)
 */

import { createQuote, getRequirementsSchema } from '../src/services/owlPayService.js';

const CUSTOMER_UUID = process.env.OWLPAY_CUSTOMER_UUID_SRL;
if (!CUSTOMER_UUID) {
  console.error('OWLPAY_CUSTOMER_UUID_SRL no configurada');
  process.exit(1);
}

// Países Harbor activos según CLAUDE.md (excluyendo EU que ya inspeccionamos)
const COUNTRIES = [
  { country: 'CN', currency: 'CNY' },
  { country: 'NG', currency: 'NGN' },
  { country: 'BR', currency: 'BRL' },
  { country: 'MX', currency: 'MXN' },
  { country: 'AE', currency: 'AED' },
  { country: 'GB', currency: 'GBP' },
  { country: 'JP', currency: 'JPY' },
  { country: 'SG', currency: 'SGD' },
  { country: 'HK', currency: 'HKD' },
  { country: 'IN', currency: 'INR' },
  { country: 'US', currency: 'USD' },
];

const SOURCE_AMOUNT = 100;

function summarizeSchema(schemaResponse) {
  const root = schemaResponse?.schema ?? schemaResponse;
  if (!root || typeof root !== 'object') return { error: 'Schema no parseable' };

  const dest = root.properties?.destination?.properties ?? {};
  const benInfo  = dest.beneficiary_info?.properties ?? {};
  const benAddr  = dest.beneficiary_info?.properties?.beneficiary_address?.properties ?? {};
  const payInstr = dest.payout_instrument?.properties ?? {};

  return {
    title: root.title ?? null,
    destination_required:        dest.beneficiary_info?.properties ? Object.keys(root.properties?.destination?.required ?? {}) : (root.properties?.destination?.required ?? []),
    beneficiary_info: {
      additionalProperties: dest.beneficiary_info?.additionalProperties ?? null,
      required:             dest.beneficiary_info?.required ?? [],
      properties:           Object.keys(benInfo),
    },
    beneficiary_address: {
      additionalProperties: dest.beneficiary_info?.properties?.beneficiary_address?.additionalProperties ?? null,
      required:             dest.beneficiary_info?.properties?.beneficiary_address?.required ?? [],
      properties:           Object.keys(benAddr),
    },
    payout_instrument: {
      additionalProperties: dest.payout_instrument?.additionalProperties ?? null,
      required:             dest.payout_instrument?.required ?? [],
      properties:           Object.keys(payInstr),
      property_patterns:    Object.fromEntries(
        Object.entries(payInstr).map(([k, v]) => [k, v.pattern ?? v.title ?? null])
      ),
    },
    transfer_purpose_enum: dest.transfer_purpose?.enum ?? [],
  };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('Harbor — Inspección de Schemas por país/método');
console.log('═══════════════════════════════════════════════════════════════');

const allResults = {};

for (const { country, currency } of COUNTRIES) {
  console.log(`\n┌─────────────────────────────────────────────────────────────┐`);
  console.log(`│ ${country} (${currency})`.padEnd(63) + '│');
  console.log(`└─────────────────────────────────────────────────────────────┘`);

  try {
    const quote = await createQuote({
      source_amount:              SOURCE_AMOUNT,
      destination_country:        country,
      destination_currency:       currency,
      destination_payment_method: 'bank_transfer',
      source_chain:               process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
      customer_uuid:              CUSTOMER_UUID,
    });

    const quotes = Array.isArray(quote.data) ? quote.data : [quote.data ?? quote];
    console.log(`  Métodos disponibles: ${quotes.map(q => q.payment_method).join(', ')}`);

    allResults[country] = {};
    for (const q of quotes) {
      const quoteId = q.id ?? q.quote_id;
      try {
        const schemaResponse = await getRequirementsSchema(quoteId);
        const summary = summarizeSchema(schemaResponse);
        allResults[country][q.payment_method] = summary;

        console.log(`\n  ── ${q.payment_method} (${summary.title}) ──`);
        console.log(`    payout_instrument:`);
        console.log(`      addtl: ${summary.payout_instrument.additionalProperties}`);
        console.log(`      required: ${summary.payout_instrument.required.join(', ')}`);
        console.log(`      allowed:  ${summary.payout_instrument.properties.join(', ')}`);
        console.log(`    beneficiary_info:`);
        console.log(`      addtl: ${summary.beneficiary_info.additionalProperties}`);
        console.log(`      required: ${summary.beneficiary_info.required.join(', ')}`);
        console.log(`      allowed:  ${summary.beneficiary_info.properties.join(', ')}`);
        console.log(`    beneficiary_address:`);
        console.log(`      required: ${summary.beneficiary_address.required.join(', ')}`);
        console.log(`      allowed:  ${summary.beneficiary_address.properties.join(', ')}`);
      } catch (err) {
        console.log(`    ❌ Schema error: ${err.message}`);
      }
    }
  } catch (err) {
    console.log(`  ❌ Quote error: ${err.message}`);
    allResults[country] = { error: err.message };
  }

  // Pequeña pausa para no saturar Harbor sandbox
  await new Promise(r => setTimeout(r, 250));
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('Inspección completa.');
console.log('═══════════════════════════════════════════════════════════════');

// Imprimir JSON completo al final para análisis posterior
console.log('\n--- JSON RESUMEN ---');
console.log(JSON.stringify(allResults, null, 2));

process.exit(0);
