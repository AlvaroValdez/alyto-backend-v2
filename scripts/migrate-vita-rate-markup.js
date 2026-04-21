/**
 * migrate-vita-rate-markup.js
 *
 * Sets vitaRateMarkup: 0.5 on all active Vita-routed corridors (SRL and SpA).
 * Idempotent — safe to run multiple times.
 *
 * Usage (Node 20.6+):
 *   node --env-file=.env scripts/migrate-vita-rate-markup.js
 *
 * Usage (older Node):
 *   node -r dotenv/config scripts/migrate-vita-rate-markup.js
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

const VITA_CORRIDORS = [
  // SRL
  'bo-ar','bo-br','bo-ca','bo-cl','bo-co','bo-cr','bo-do',
  'bo-ec','bo-es','bo-gt','bo-hk','bo-ht','bo-mx','bo-pa',
  'bo-pe','bo-pl','bo-py','bo-sv','bo-us','bo-uy','bo-ve',
  // SpA
  'cl-ar','cl-bo','cl-br','cl-co','cl-mx','cl-pe','cl-uy',
  'cl-ve','cl-ec','cl-gt','cl-cr','cl-pa','cl-do','cl-py',
  'cl-sv','cl-ht','cl-ca','cl-us','cl-es','cl-pl','cl-hk',
];

console.log('🔄 Setting vitaRateMarkup: 0.5 on all Vita corridors...');

let updated = 0;
let notFound = 0;

for (const corridorId of VITA_CORRIDORS) {
  const result = await db.collection('transaction_configs').updateOne(
    { corridorId },
    {
      $set: {
        vitaRateMarkup: 0.5,
        updatedAt: new Date(),
      },
    },
  );
  if (result.matchedCount > 0) {
    console.log(`   ✅ ${corridorId} → vitaRateMarkup: 0.5`);
    updated++;
  } else {
    console.log(`   ⚠️  ${corridorId} → not found in DB`);
    notFound++;
  }
}

console.log('');
console.log(`📊 Updated: ${updated} | Not found: ${notFound}`);

const sample = await db.collection('transaction_configs')
  .findOne({ corridorId: 'bo-co' }, { projection: { corridorId: 1, vitaRateMarkup: 1 } });
console.log('Sample bo-co:', JSON.stringify(sample));

console.log('');
console.log('✅ Migration complete.');
await mongoose.disconnect();
process.exit(0);
