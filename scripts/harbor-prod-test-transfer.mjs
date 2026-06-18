// scripts/harbor-prod-test-transfer.mjs
// Prueba real Harbor (Fase C) — AV Finance mueve sus PROPIOS fondos:
// off-ramp USDC → USD vía ACH a una cuenta bancaria de EE.UU. de AV Finance LLC,
// on_behalf_of = Customer LLC aprobado. NO es el flujo retail SRL.
//
// ⚠️ SOLO EN EL VPS PROD. Mueve USDC real desde la wallet de tesorería.
//
// Modos:
//   (default)   dry-run: quote + requirements + createTransfer (valida todo,
//               obtiene instruction_address). NO envía USDC.
//   --confirm   ejecuta además sendUSDCToHarbor → ENVÍA USDC REAL.
//
// Datos bancarios y monto se toman de ENV VARS (nunca en código/git):
//   HARBOR_TEST_AMOUNT          (USD, default 100)
//   HARBOR_TEST_SOURCE_ADDRESS  (wallet origen USDC; default STELLAR_SRL_PUBLIC_KEY)
//   HARBOR_TEST_HOLDER          account_holder_name (titular de la cuenta US)
//   HARBOR_TEST_BANK_NAME       bank_name
//   HARBOR_TEST_ACCOUNT         account_number
//   HARBOR_TEST_ROUTING         routing_number (ABA, 9 dígitos)
//   HARBOR_TEST_FIRST/LAST      nombre del beneficiario (beneficiary_info)
//   HARBOR_TEST_STREET/CITY     domicilio del beneficiario
//   HARBOR_TEST_DOB             yyyy-mm-dd (default 1990-01-01)
//   HARBOR_TEST_DOCNUM          documento del beneficiario (opcional)
//
// Uso (dentro del contenedor backend, env inyectado por compose):
//   docker compose exec alyto-backend node scripts/harbor-prod-test-transfer.mjs            # dry-run
//   docker compose exec alyto-backend node scripts/harbor-prod-test-transfer.mjs 100 --confirm
import {
  getCustomerUuid,
  getHarborQuote,
  getHarborTransferRequirements,
  createHarborTransfer,
  sendUSDCToHarbor,
  getOwlPayBaseUrl,
} from '../src/services/owlPayService.js'

const args    = process.argv.slice(2)
const CONFIRM = args.includes('--confirm')
const amount  = Number(args.find(a => /^\d+(\.\d+)?$/.test(a)) ?? process.env.HARBOR_TEST_AMOUNT ?? 100)

const DEST_COUNTRY  = 'US'
const DEST_CURRENCY = 'USD'

// ── Validaciones de entorno ───────────────────────────────────────────────────
function need(key, label) {
  const v = process.env[key]
  if (!v || !String(v).trim()) { console.error(`❌ Falta env ${key} (${label})`); process.exit(1) }
  return String(v).trim()
}

const customerUuid = getCustomerUuid('LLC')
if (!customerUuid) { console.error('❌ OWLPAY_CUSTOMER_UUID_LLC no configurado.'); process.exit(1) }

const baseUrl = getOwlPayBaseUrl()
if (/sandbox/i.test(baseUrl)) {
  console.error(`❌ OWLPAY_BASE_URL apunta a SANDBOX (${baseUrl}). Abortando — la prueba real es solo prod.`)
  process.exit(1)
}

const sourceAddress = process.env.HARBOR_TEST_SOURCE_ADDRESS || process.env.STELLAR_SRL_PUBLIC_KEY
if (!sourceAddress) { console.error('❌ Falta HARBOR_TEST_SOURCE_ADDRESS / STELLAR_SRL_PUBLIC_KEY (wallet origen USDC).'); process.exit(1) }

const holder  = need('HARBOR_TEST_HOLDER',    'titular cuenta US')
const bankName = need('HARBOR_TEST_BANK_NAME', 'nombre del banco')
const account = need('HARBOR_TEST_ACCOUNT',   'número de cuenta')
const routing = need('HARBOR_TEST_ROUTING',   'routing ABA (9 dígitos)')
if (!/^[0-9]{9}$/.test(routing)) { console.error(`❌ HARBOR_TEST_ROUTING inválido (9 dígitos): ${routing}`); process.exit(1) }

const beneficiary = {
  firstName:      process.env.HARBOR_TEST_FIRST ?? 'AV Finance',
  lastName:       process.env.HARBOR_TEST_LAST  ?? 'LLC',
  dateOfBirth:    process.env.HARBOR_TEST_DOB   ?? '1990-01-01',
  documentNumber: process.env.HARBOR_TEST_DOCNUM ?? '',
  address: {
    street: process.env.HARBOR_TEST_STREET ?? 'N/A',
    city:   process.env.HARBOR_TEST_CITY   ?? 'N/A',
  },
  dynamicFields: {
    account_holder_name: holder,
    bank_name:           bankName,
    account_number:      account,
    routing_number:      routing,
  },
}

const alytoTransactionId = `ALY-HARBORTEST-${Date.now()}`

console.log('\n════════ Harbor PROD test transfer ════════')
console.log(`Modo:           ${CONFIRM ? '🟥 CONFIRM (envía USDC REAL)' : '🟡 DRY-RUN (no envía USDC)'}`)
console.log(`Base URL:       ${baseUrl}`)
console.log(`on_behalf_of:   ${customerUuid}`)
console.log(`source wallet:  ${sourceAddress}`)
console.log(`monto:          ${amount} USDC → USD (ACH) a cuenta US`)
console.log(`beneficiario:   ${holder} · ${bankName} · ****${account.slice(-4)} · routing ${routing}`)
console.log(`alytoTxId:      ${alytoTransactionId}`)
console.log('═══════════════════════════════════════════\n')

// ── 1) Quote ──────────────────────────────────────────────────────────────────
const quote = await getHarborQuote({
  sourceAmount:   amount,
  sourceCurrency: 'USDC',
  sourceChain:    process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
  destCountry:    DEST_COUNTRY,
  destCurrency:   DEST_CURRENCY,
  customerUuid,
})
console.log('① QUOTE:')
console.log(`   quoteId:        ${quote.quoteId}`)
console.log(`   método:         ${quote.paymentMethodLabel ?? quote.paymentMethod ?? '—'}`)
console.log(`   USDC origen:    ${quote.sourceAmount} ${quote.sourceCurrency}`)
console.log(`   USD destino:    ${quote.destinationAmount} ${quote.destinationCurrency}  (rate ${quote.exchangeRate})`)
console.log(`   harborFee:      ${quote.harborFee}   commissionFee: ${quote.commissionFee}`)
console.log(`   settlement:     ${quote.settlementTimeMin ?? '?'}-${quote.settlementTimeMax ?? '?'} ${quote.settlementTimeUnit ?? ''}`)

// ── 2) Requirements ───────────────────────────────────────────────────────────
const reqs = await getHarborTransferRequirements({ quoteId: quote.quoteId, destCountry: DEST_COUNTRY })
const required = reqs?.schema?.required ?? reqs?.raw?.schema?.required ?? null
console.log('\n② REQUIREMENTS (campos del beneficiario):')
console.log(`   ${required ? JSON.stringify(required) : '(ver schema crudo)'}`)

// ── 3) Create transfer (valida beneficiario, obtiene instruction_address) ─────
console.log('\n③ CREATE TRANSFER…')
const transfer = await createHarborTransfer({
  quoteId:            quote.quoteId,
  customerUuid,
  alytoTransactionId,
  sourceAddress,
  beneficiary,
  destCountry:        DEST_COUNTRY,
  destCurrency:       DEST_CURRENCY,
})
console.log(`   harborTransferId:   ${transfer.harborTransferId}`)
console.log(`   status:             ${transfer.status}`)
console.log(`   instruction_address:${transfer.instructionAddress}`)
console.log(`   instruction_memo:   ${transfer.instructionMemo}`)
console.log(`   instruction_chain:  ${transfer.instructionChain}`)
console.log(`   USD a recibir:      ${transfer.destinationAmount} ${transfer.destinationCurrency}`)
console.log(`   expira:             ${transfer.expiresAt}`)

if (!CONFIRM) {
  console.log('\n🟡 DRY-RUN — transfer creado en Harbor pero NO se envió USDC.')
  console.log('   Revisá el quote/fee/instruction_address arriba. Si todo OK, re-ejecutá con --confirm.')
  console.log('   (El transfer sin fondear expira solo; no mueve dinero.)')
  process.exit(0)
}

// ── 4) Enviar USDC real ───────────────────────────────────────────────────────
if (!transfer.instructionAddress) {
  console.error('❌ Harbor no devolvió instruction_address — no se puede fondear. Abortando.')
  process.exit(1)
}
console.log('\n④ ENVIANDO USDC REAL a la instruction address…')
const sendRes = await sendUSDCToHarbor({
  instructionAddress: transfer.instructionAddress,
  instructionMemo:    transfer.instructionMemo,
  instructionChain:   transfer.instructionChain,
  amount,
  alytoTransactionId,
})
console.log('   ✅ USDC enviado:', JSON.stringify(sendRes))
console.log('\n✅ Transfer fondeado. Seguí el estado en los logs (webhook harbor-signature):')
console.log(`   transfer.source_received → transfer.completed`)
console.log(`   harborTransferId = ${transfer.harborTransferId}`)
process.exit(0)
