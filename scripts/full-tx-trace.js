/**
 * full-tx-trace.js — Traza completa de una transacción para auditoría.
 *
 * Uso: node --env-file=.env scripts/full-tx-trace.js [ALY-...]
 *   sin argumento → última transacción
 */

import mongoose from 'mongoose';
import Transaction from '../src/models/Transaction.js';

const arg = process.argv[2];
await mongoose.connect(process.env.MONGODB_URI);

const query  = arg ? { alytoTransactionId: arg } : {};
const sort   = arg ? null : { createdAt: -1 };
const cursor = Transaction.findOne(query);
if (sort) cursor.sort(sort);
const tx = await cursor.lean();

if (!tx) { console.error('Tx no encontrada'); process.exit(1); }

const fmt    = (n, c) => n != null ? `${Number(n).toLocaleString('es', { maximumFractionDigits: 4 })} ${c ?? ''}`.trim() : '—';
const date   = (d) => d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—';
const line   = '─'.repeat(72);
const dline  = '═'.repeat(72);

const df = (tx.beneficiaryDetails?.dynamicFields ?? tx.beneficiary?.dynamicFields ?? {});
const dfObj = df instanceof Map ? Object.fromEntries(df.entries()) : df;

console.log(`\n${dline}`);
console.log(`TRACE: ${tx.alytoTransactionId}`);
console.log(dline);

// ─── 1. IDENTIDAD & ESTADO ────────────────────────────────────────────────
console.log('\n📌 IDENTIDAD Y ESTADO');
console.log(line);
console.log(`  Status actual:       ${tx.status}`);
console.log(`  Status reason:       ${tx.statusReason ?? '—'}`);
console.log(`  Failure (admin):     ${tx.failureReason ?? '—'}`);
console.log(`  Failure (user):      ${tx.userFailureReason ?? '—'}`);
console.log(`  Failure category:    ${tx.failureCategory ?? '—'}`);
console.log(`  Failure retryable:   ${tx.failureRetryable ?? false}`);
console.log(`  Legal entity:        ${tx.legalEntity}`);
console.log(`  Corredor:            ${tx.corridorCode}`);
console.log(`  País origen → dest:  ${tx.originCountry} → ${tx.destinationCountry}`);
console.log(`  Currency:            ${tx.originCurrency} → ${tx.destinationCurrency}`);

// ─── 2. MONTOS ────────────────────────────────────────────────────────────
console.log('\n💰 MONTOS');
console.log(line);
console.log(`  Original amount:     ${fmt(tx.originalAmount, tx.originCurrency)}`);
console.log(`  Destination amount:  ${fmt(tx.destinationAmount, tx.destinationCurrency)}`);
console.log(`  Exchange rate:       ${tx.exchangeRate ?? '—'}`);
if (tx.usdcAmount != null)        console.log(`  USDC equivalent:     ${fmt(tx.usdcAmount, 'USDC')}`);
if (tx.bobPerUsdc != null)        console.log(`  BOB/USDT rate:       ${tx.bobPerUsdc}`);
if (tx.conversionRate != null)    console.log(`  Conversion rate:     ${tx.conversionRate}`);
if (tx.digitalAssetAmount != null) console.log(`  Digital asset amt:   ${fmt(tx.digitalAssetAmount, 'USDC')}`);

// ─── 3. FEES ──────────────────────────────────────────────────────────────
console.log('\n💸 FEES (desglose desde transaction.fees)');
console.log(line);
const f = tx.fees ?? {};
console.log(`  alytoCSpread:        ${fmt(f.alytoCSpread,    f.feeCurrency ?? tx.originCurrency)}`);
console.log(`  fixedFee:            ${fmt(f.fixedFee,        f.feeCurrency ?? tx.originCurrency)}`);
console.log(`  payinFee:            ${fmt(f.payinFee,        f.feeCurrency ?? tx.originCurrency)}`);
console.log(`  payoutFee:           ${fmt(f.payoutFee,       f.feeCurrency ?? tx.originCurrency)}`);
console.log(`  profitRetention:     ${fmt(f.profitRetention, f.feeCurrency ?? tx.originCurrency)} (oculto al usuario)`);
console.log(`  ─────────────────────`);
console.log(`  TOTAL deducted:      ${fmt(f.totalDeducted,   f.feeCurrency ?? tx.originCurrency)}`);
console.log(`  Fee currency:        ${f.feeCurrency ?? tx.originCurrency}`);

if (tx.feeBreakdown) {
  console.log('\n  Legacy feeBreakdown:');
  const fb = tx.feeBreakdown;
  console.log(`    alytoFee:          ${fmt(fb.alytoFee, fb.feeCurrency)}`);
  console.log(`    providerFee:       ${fmt(fb.providerFee, fb.feeCurrency)}`);
  console.log(`    networkFee:        ${fmt(fb.networkFee, fb.feeCurrency)}`);
  console.log(`    totalFee:          ${fmt(fb.totalFee, fb.feeCurrency)}`);
}

// ─── 4. PAYIN / PAYOUT ────────────────────────────────────────────────────
console.log('\n🏦 PAYIN / PAYOUT');
console.log(line);
console.log(`  payinMethod:         ${tx.payinMethod ?? '—'}`);
console.log(`  payoutMethod:        ${tx.payoutMethod ?? '—'}`);
console.log(`  owlPayMethod:        ${tx.owlPayMethod ?? '—'}`);
console.log(`  payinReference:      ${tx.payinReference ?? '—'}`);
console.log(`  payoutReference:     ${tx.payoutReference ?? '—'}`);
console.log(`  providerQuoteId:     ${tx.providerQuoteId ?? '—'}`);
console.log(`  payoutQuoteId:       ${tx.payoutQuoteId ?? '—'}`);
console.log(`  rateExpiresAt:       ${date(tx.rateExpiresAt)}`);

// ─── 5. BENEFICIARIO ──────────────────────────────────────────────────────
console.log('\n👤 BENEFICIARIO');
console.log(line);
const ben = tx.beneficiary ?? tx.beneficiaryDetails ?? {};
console.log(`  firstName/lastName:  ${ben.firstName ?? '—'} ${ben.lastName ?? ''}`);
console.log(`  bankCode:            ${ben.bankCode ?? '—'}`);
console.log(`  accountBank:         ${ben.accountBank ?? '—'}`);
console.log(`  accountType:         ${ben.accountType ?? '—'}`);
console.log(`  documentType:        ${ben.documentType ?? '—'}`);
console.log(`  documentNumber:      ${ben.documentNumber ?? '—'}`);
console.log('  dynamicFields:');
Object.entries(dfObj).forEach(([k, v]) => console.log(`    ${k.padEnd(28)} ${v}`));

// ─── 6. HARBOR TRANSFER ───────────────────────────────────────────────────
if (tx.harborTransfer) {
  console.log('\n🚢 HARBOR TRANSFER (off-ramp USDC)');
  console.log(line);
  const h = tx.harborTransfer;
  console.log(`  transferId:          ${h.transferId ?? '—'}`);
  console.log(`  status (Harbor):     ${h.status ?? '—'}`);
  console.log(`  USDC requerido:      ${fmt(h.usdcAmountRequired, 'USDC')}`);
  console.log(`  instruction_address: ${h.instructionAddress ?? '—'}`);
  console.log(`  instruction_memo:    ${h.instructionMemo ?? '—'}`);
  console.log(`  instruction_chain:   ${h.instructionChain ?? '—'}`);
  console.log(`  quoteId:             ${h.quoteId ?? '—'}`);
  console.log(`  expiresAt:           ${date(h.expiresAt)}`);
}

// ─── 7. STELLAR ───────────────────────────────────────────────────────────
console.log('\n⭐ STELLAR (blockchain trail)');
console.log(line);
console.log(`  stellarTxHash:       ${tx.stellarTxHash ?? '—'}`);
console.log(`  stellarTxId:         ${tx.stellarTxId  ?? '—'}`);
console.log(`  stellarLedger:       ${tx.stellarLedger ?? '—'}`);
if (tx.stellarTxHash) {
  console.log(`  Explorer:            https://stellar.expert/explorer/testnet/tx/${tx.stellarTxHash}`);
}

// ─── 8. PROVIDERS USED ────────────────────────────────────────────────────
console.log('\n🔌 PROVEEDORES USADOS');
console.log(line);
(tx.providersUsed ?? []).forEach(p => console.log(`  - ${p}`));

// ─── 9. TIMELINE / IPN LOG ────────────────────────────────────────────────
console.log('\n📋 IPN LOG (timeline completo)');
console.log(line);
(tx.ipnLog ?? []).forEach((entry, i) => {
  console.log(`  ${(i+1).toString().padStart(2)}. [${date(entry.receivedAt ?? entry.createdAt)}] ${entry.eventType ?? entry.event ?? '?'}`);
  console.log(`      provider: ${entry.provider ?? '?'} | status: ${entry.status ?? '?'}`);
  if (entry.rawPayload && Object.keys(entry.rawPayload).length > 0) {
    const sample = JSON.stringify(entry.rawPayload).slice(0, 150);
    console.log(`      payload:  ${sample}${sample.length === 150 ? '...' : ''}`);
  }
});

// ─── 10. RATE HISTORY ──────────────────────────────────────────────────────
if (tx.rateHistory?.length) {
  console.log('\n📊 RATE HISTORY (ajustes de tasa por Harbor)');
  console.log(line);
  tx.rateHistory.forEach((r, i) => {
    console.log(`  ${i+1}. [${date(r.at)}] ${r.reason ?? '?'}`);
    console.log(`     ${fmt(r.previousAmount, tx.destinationCurrency)} → ${fmt(r.newAmount, tx.destinationCurrency)} (${r.diffPercent ?? '?'}%)`);
  });
}

// ─── 11. METADATOS ────────────────────────────────────────────────────────
console.log('\n🕐 METADATOS');
console.log(line);
console.log(`  createdAt:           ${date(tx.createdAt)}`);
console.log(`  updatedAt:           ${date(tx.updatedAt)}`);
console.log(`  userId:              ${tx.userId}`);
console.log(`  corridorId:          ${tx.corridorId}`);
console.log(`  concept:             ${tx.concept ?? '—'}`);

console.log(`\n${dline}\n`);

await mongoose.disconnect();
process.exit(0);
