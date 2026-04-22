/**
 * migrate-remove-vita-markup.js
 *
 * Normalizes fees.vitaRateMarkup to 0 on all historical transactions.
 * Does NOT recalculate destinationAmount — historical records are preserved
 * as-issued. This only brings the markup field into compliance with
 * docs/SEND_MONEY_FLOW.md v1.0 §3.5, §6.9 (schema field kept, always 0).
 *
 * Idempotent — safe to run multiple times.
 *
 * Usage (Node 20.6+):
 *   node --env-file=.env scripts/migrate-remove-vita-markup.js
 *
 * Usage (older Node):
 *   node -r dotenv/config scripts/migrate-remove-vita-markup.js
 */

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not set');
  process.exit(1);
}

await mongoose.connect(MONGODB_URI);
const db = mongoose.connection.db;
console.log('✅ Connected to:', db.databaseName);
console.log('');

console.log('🔄 Normalizing fees.vitaRateMarkup → 0 on historical transactions...');

const txResult = await db.collection('transactions').updateMany(
  { 'fees.vitaRateMarkup': { $gt: 0 } },
  { $set: { 'fees.vitaRateMarkup': 0 } },
);
console.log(`   transactions normalized: ${txResult.modifiedCount} / matched: ${txResult.matchedCount}`);

console.log('🔄 Normalizing vitaRateMarkup → 0 on transactionconfigs (corridors)...');
const cfgResult = await db.collection('transactionconfigs').updateMany(
  { vitaRateMarkup: { $gt: 0 } },
  { $set: { vitaRateMarkup: 0 } },
);
console.log(`   corridors normalized:     ${cfgResult.modifiedCount} / matched: ${cfgResult.matchedCount}`);

console.log('');
console.log('✅ Done. vitaRateMarkup fields are now 0 across the collection.');

await mongoose.disconnect();
process.exit(0);
