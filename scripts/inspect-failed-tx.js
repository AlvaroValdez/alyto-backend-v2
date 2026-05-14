/**
 * inspect-failed-tx.js — lee una tx específica de la DB y muestra el estado
 * relevante para diagnosticar fallos de Harbor.
 *
 * Uso: node --env-file=.env scripts/inspect-failed-tx.js ALY-C-...
 */

import mongoose from 'mongoose';
import Transaction from '../src/models/Transaction.js';

const txId = process.argv[2];
if (!txId) { console.error('Uso: scripts/inspect-failed-tx.js <transactionId>'); process.exit(1); }

await mongoose.connect(process.env.MONGODB_URI);
console.log('DB:', mongoose.connection.db.databaseName);

const tx = await Transaction.findOne({ alytoTransactionId: txId }).lean();
if (!tx) { console.error('Tx no encontrada:', txId); process.exit(1); }

console.log('\n══ Transaction state ══');
console.log('  alytoTransactionId:', tx.alytoTransactionId);
console.log('  status:            ', tx.status);
console.log('  legalEntity:       ', tx.legalEntity);
console.log('  corridorCode:      ', tx.corridorCode);
console.log('  originCountry:     ', tx.originCountry, '→', tx.destinationCountry);
console.log('  originAmount:      ', tx.originalAmount, tx.originCurrency);
console.log('  destinationAmount: ', tx.destinationAmount, tx.destinationCurrency);
console.log('  payoutMethod:      ', tx.payoutMethod);
console.log('  owlPayMethod:      ', tx.owlPayMethod);
console.log('  providerQuoteId:   ', tx.providerQuoteId);
console.log('  payoutQuoteId:     ', tx.payoutQuoteId);
console.log('  rateExpiresAt:     ', tx.rateExpiresAt);
console.log('  failureReason:     ', tx.failureReason);
console.log('  beneficiary.dynamicFields:');
const df = tx.beneficiaryDetails?.dynamicFields ?? tx.beneficiary?.dynamicFields ?? {};
const dfObj = df instanceof Map ? Object.fromEntries(df.entries()) : df;
console.log(JSON.stringify(dfObj, null, 2));

if (tx.harborTransfer) {
  console.log('\n  harborTransfer:');
  console.log(JSON.stringify(tx.harborTransfer, null, 2));
}

if (tx.ipnLog?.length) {
  console.log('\n  ipnLog (últimas 3):');
  tx.ipnLog.slice(-3).forEach(log => {
    console.log('   - [' + (log.timestamp ?? log.createdAt) + '] ' + log.event + ' (' + log.provider + '/' + log.status + ')');
  });
}

await mongoose.disconnect();
process.exit(0);
