/**
 * audit-harbor-end-to-end.js
 *
 * Para cada país/método activo:
 *   1. Obtiene quote
 *   2. Obtiene schema
 *   3. INTENTA crear transfer real con datos de prueba alineados al schema
 *   4. Reporta si hay discrepancia schema-vs-impl (como el bug EU SEPA)
 *
 * Datos de prueba por país (sandbox Harbor — beneficiarios ficticios pero
 * con formato válido para schema). Si el transfer falla con código 3004
 * (no 2005), es bug de Harbor — schema dice una cosa, implementación otra.
 *
 * Uso: node --env-file=.env scripts/audit-harbor-end-to-end.js
 */

import { createQuote, createTransfer, getCustomerUuid } from '../src/services/owlPayService.js';

const CUSTOMER_UUID  = getCustomerUuid();
const SOURCE_ADDRESS = process.env.STELLAR_SRL_PUBLIC_KEY
  || 'GDA46XONBJOTZSONYXK6ZLI2QTSHC3ZI4F66H2A5J2V5OW6RU65NOITS';

if (!CUSTOMER_UUID) { console.error('Customer UUID no configurado'); process.exit(1); }

// ─── Test data por país/método ──────────────────────────────────────────────
// Cada entry define el payload mínimo válido per schema oficial.
const TEST_CASES = [
  {
    label:     'CN CIPS',
    country:   'CN', currency: 'CNY', amount: 100, methodPref: 'CIPS',
    addr:      { street: '123 Nanjing Rd', city: 'Shanghai', country: 'CN', postal_code: '200001', state_province: 'SH' },
    benefName: 'Wei Zhang',
    payout:    { account_holder_name: 'Zhang Wei', bank_name: 'ICBC', account_number: '6222021234565488', swift_code: 'ICBKCNBJXXX' },
  },
  {
    label:     'CN WIRE',
    country:   'CN', currency: 'CNY', amount: 100, methodPref: 'WIRE',
    addr:      { street: '123 Nanjing Rd', city: 'Shanghai', country: 'CN', postal_code: '200001', state_province: 'SH' },
    benefName: 'Wei Zhang',
    payout:    { account_holder_name: 'Zhang Wei', bank_name: 'ICBC', account_number: '6222021234565488', swift_code: 'ICBKCNBJXXX' },
  },
  {
    label:     'NG BANK-TRANSFER',
    country:   'NG', currency: 'NGN', amount: 100, methodPref: 'BANK-TRANSFER',
    addr:      { street: '10 Marina St', city: 'Lagos', state_province: 'LA', country: 'NG', postal_code: '101001' },
    benefName: 'Chidi Okeke',
    payout:    { account_holder_name: 'Chidi Okeke', bank_name: 'Zenith Bank', account_number: '0123456789' },
  },
  {
    label:     'BR PIX',
    country:   'BR', currency: 'BRL', amount: 100, methodPref: 'PIX',
    addr:      { street: 'Av Paulista 1000', city: 'São Paulo', state_province: 'SP', country: 'BR', postal_code: '01310-100' },
    benefName: 'João Silva',
    // CPF válido (mod-11 checksum) + email como PIX key alternativa
    payout:    { br_cpf: '11144477735', email: 'joao@example.com' },
  },
  {
    label:     'MX SPEI',
    country:   'MX', currency: 'MXN', amount: 100, methodPref: 'SPEI',
    addr:      { street: 'Av Reforma 500', city: 'Ciudad de México', state_province: 'CMX', country: 'MX', postal_code: '06600' },
    benefName: 'María García',
    benefDob:  '1990-01-01',
    benefIdDoc:'CURP12345MGDF',
    payout:    { mx_clabe: '646180157000000004' },
  },
  {
    label:     'AE FTS',
    country:   'AE', currency: 'AED', amount: 100, methodPref: 'FTS',
    addr:      { street: 'Sheikh Zayed Rd', city: 'Dubai', state_province: 'DU', country: 'AE', postal_code: '00000' },
    benefName: 'Ahmed Al Rashidi',
    payout:    { account_holder_name: 'Ahmed Al Rashidi', phone_number: '+971501234567', swift_code: 'EBILAEAD', account_number: 'AE070331234567890123456' },
  },
  {
    label:     'AE AANI',
    country:   'AE', currency: 'AED', amount: 100, methodPref: 'AANI',
    addr:      { street: 'Sheikh Zayed Rd', city: 'Dubai', state_province: 'DU', country: 'AE', postal_code: '00000' },
    benefName: 'Ahmed Al Rashidi',
    payout:    { account_holder_name: 'Ahmed Al Rashidi', phone_number: '+971501234567', swift_code: 'EBILAEAD', account_number: 'AE070331234567890123456' },
  },
  // HK CHATS removido — no disponible para nuestro customer en sandbox.
  {
    label:     'HK WIRE',
    country:   'HK', currency: 'HKD', amount: 100, methodPref: 'WIRE',
    addr:      { street: '88 Queensway', city: 'Central', state_province: 'HK', country: 'HK', postal_code: '999077' },
    benefName: 'Chan Tai Man',
    payout:    { account_holder_name: 'Chan Tai Man', bank_name: 'HSBC HK', account_number: '123456789001', swift_code: 'HSBCHKHHHKH' },
  },
  {
    label:     'IN IMPS',
    country:   'IN', currency: 'INR', amount: 100, methodPref: 'IMPS',
    addr:      { street: 'MG Road', city: 'Bangalore', state_province: 'KA', country: 'IN', postal_code: '560001' },
    benefName: 'Rahul Sharma',
    benefDob:  '1990-01-01',
    benefIdDoc:'ABCDE1234F',
    benefEmail:'rahul@example.com',
    benefPhone:'+919876543210',
    payout:    { bank_code: 'HDFC0001234', account_number: '012345678901' },
  },
  {
    label:     'SG BANK-TRANSFER',
    country:   'SG', currency: 'SGD', amount: 100, methodPref: 'BANK-TRANSFER',
    addr:      { street: '1 Raffles Pl', city: 'Singapore', state_province: 'SG', country: 'SG', postal_code: '048616' },
    benefName: 'Lee Wei Ming',
    payout:    { account_holder_name: 'Lee Wei Ming', bank_name: 'DBS Bank', account_number: '1234567890', swift_code: 'DBSSSGSG' },
  },
  {
    label:     'EU SEPA',
    country:   'DE', currency: 'EUR', amount: 100, methodPref: 'SEPA',
    addr:      { street: 'Hauptstraße 15', city: 'Berlin', country: 'DE', postal_code: '10115' },
    benefName: 'Hans Müller',
    payout:    { account_holder_name: 'Hans Müller', account_number: 'DE89370400440532013000' },
  },
  {
    label:     'EU WIRE',
    country:   'DE', currency: 'EUR', amount: 100, methodPref: 'WIRE',
    addr:      { street: 'Hauptstraße 15', city: 'Berlin', country: 'DE', postal_code: '10115' },
    benefName: 'Hans Müller',
    payout:    { account_holder_name: 'Hans Müller', bank_name: 'Commerzbank', account_number: 'DE89370400440532013000', swift_code: 'COBADEFFXXX' },
  },
];

const results = [];

for (const tc of TEST_CASES) {
  console.log(`\n══ ${tc.label} ══`);
  let status = 'UNKNOWN', detail = '';

  try {
    const quote = await createQuote({
      source_amount:              tc.amount,
      destination_country:        tc.country,
      destination_currency:       tc.currency,
      destination_payment_method: 'bank_transfer',
      source_chain:               process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
      customer_uuid:              CUSTOMER_UUID,
    });
    const quotes = Array.isArray(quote.data) ? quote.data : [quote.data ?? quote];
    const q = quotes.find(x => x.payment_method === tc.methodPref) ?? quotes[0];
    if (!q) throw new Error(`Método ${tc.methodPref} no disponible (quotes: ${quotes.map(x => x.payment_method).join(',')})`);
    console.log(`   ✓ Quote ${q.payment_method} (${q.id?.slice(0,16)}...)`);

    // Build beneficiary_info
    const benef = { beneficiary_name: tc.benefName, beneficiary_address: tc.addr };
    if (tc.benefDob)   benef.beneficiary_dob           = tc.benefDob;
    if (tc.benefIdDoc) benef.beneficiary_id_doc_number = tc.benefIdDoc;
    if (tc.benefEmail) benef.beneficiary_email         = tc.benefEmail;
    if (tc.benefPhone) benef.beneficiary_phone_number  = tc.benefPhone;

    // Try create transfer
    const transfer = await createTransfer({
      quote_id:                  q.id ?? q.quote_id,
      on_behalf_of:              CUSTOMER_UUID,
      application_transfer_uuid: `ALY-AUDIT-${tc.country}-${tc.methodPref}-${Date.now()}`,
      source_address:            SOURCE_ADDRESS,
      beneficiary_info:          benef,
      payout_instrument:         tc.payout,
      transfer_purpose:          'FAMILY_MAINTENANCE',
      is_self_transfer:          false,
    });
    const td = transfer.data ?? transfer;
    status = 'OK';
    detail = `transfer ${(td.uuid ?? td.id)?.slice(0, 24)}... status=${td.status}`;
    console.log(`   ✅ ${detail}`);
  } catch (err) {
    const data = err.data ?? {};
    if (data.code === 2005) {
      status = 'SCHEMA-ERR';
      detail = data.message;
    } else if (data.code === 3004) {
      status = 'IMPL-BUG'; // schema-vs-impl discrepancy (como SEPA)
      detail = JSON.stringify(data.details ?? data.message);
    } else if (data.code === 3018) {
      status = 'NO-CORRIDOR';
      detail = 'Customer no tiene acceso al corredor';
    } else {
      status = 'ERR-' + (data.code ?? 'unknown');
      detail = err.message;
    }
    console.log(`   ❌ ${status}: ${detail}`);
  }

  results.push({ test: tc.label, status, detail });
  await new Promise(r => setTimeout(r, 500));  // evitar rate limit
}

// ─── Resumen final ──────────────────────────────────────────────────────────
console.log('\n\n═══════════════════════════════════════════════════════════════');
console.log('RESUMEN END-TO-END');
console.log('═══════════════════════════════════════════════════════════════');
results.forEach(r => {
  const icon = r.status === 'OK' ? '✅' : r.status === 'IMPL-BUG' ? '🐛' : r.status === 'NO-CORRIDOR' ? '⛔' : '❌';
  console.log(`${icon} ${r.test.padEnd(28)} ${r.status.padEnd(14)} ${r.detail}`);
});

process.exit(0);
