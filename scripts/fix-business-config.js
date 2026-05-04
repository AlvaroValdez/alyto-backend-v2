import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not set');
  process.exit(1);
}

await mongoose.connect(MONGODB_URI);
const db = mongoose.connection.db;
console.log('✅ Connected to:', db.databaseName);
console.log('─'.repeat(60));

// ════════════════════════════════════════════════════════════
// FIX 1 — businessAlytoCSpread = 0.5 on ALL active corridors
// ════════════════════════════════════════════════════════════
console.log('\n📊 FIX 1 — Business spread on active corridors');

const beforeCount = await db.collection('transaction_configs')
  .countDocuments({ isActive: true, businessAlytoCSpread: { $ne: null } });
console.log(`  Before: ${beforeCount} corridors with businessAlytoCSpread set`);

const spreadResult = await db.collection('transaction_configs')
  .updateMany(
    { isActive: true },
    { $set: { businessAlytoCSpread: 0.5 } }
  );
console.log(`  ✅ Updated: ${spreadResult.modifiedCount} corridors → businessAlytoCSpread: 0.5`);

const afterCount = await db.collection('transaction_configs')
  .countDocuments({ isActive: true, businessAlytoCSpread: { $ne: null } });
console.log(`  After: ${afterCount} corridors with businessAlytoCSpread set`);

// ════════════════════════════════════════════════════════════
// FIX 2 — Revert pending/under_review KYB users to 'personal'
// ════════════════════════════════════════════════════════════
console.log('\n👤 FIX 2 — Revert pending KYB users to personal accountType');

const pendingBusinessUsers = await db.collection('users')
  .find({
    kybStatus: { $in: ['pending', 'under_review', 'more_info', 'unfinished', 'finished'] },
    accountType: 'business'
  })
  .project({ email: 1, kybStatus: 1, accountType: 1 })
  .toArray();

console.log(`  Found ${pendingBusinessUsers.length} users to revert:`);
pendingBusinessUsers.forEach(u =>
  console.log(`    - ${u.email} (kybStatus: ${u.kybStatus})`)
);

if (pendingBusinessUsers.length > 0) {
  const revertResult = await db.collection('users').updateMany(
    {
      kybStatus: { $in: ['pending', 'under_review', 'more_info', 'unfinished', 'finished'] },
      accountType: 'business'
    },
    { $set: { accountType: 'personal' } }
  );
  console.log(`  ✅ Reverted: ${revertResult.modifiedCount} users → accountType: 'personal'`);
} else {
  console.log('  ✅ No users to revert');
}

// ════════════════════════════════════════════════════════════
// FIX 3 — Ensure approved KYB users have accountType='business'
// ════════════════════════════════════════════════════════════
console.log('\n✅ FIX 3 — Ensure approved KYB users have business accountType');

const approvedPersonalUsers = await db.collection('users')
  .find({
    kybStatus: 'approved',
    accountType: 'personal'
  })
  .project({ email: 1, kybStatus: 1 })
  .toArray();

console.log(`  Found ${approvedPersonalUsers.length} approved users with wrong accountType:`);
approvedPersonalUsers.forEach(u =>
  console.log(`    - ${u.email}`)
);

if (approvedPersonalUsers.length > 0) {
  const approvedResult = await db.collection('users').updateMany(
    { kybStatus: 'approved', accountType: 'personal' },
    { $set: { accountType: 'business' } }
  );
  console.log(`  ✅ Fixed: ${approvedResult.modifiedCount} users → accountType: 'business'`);
} else {
  console.log('  ✅ All approved KYB users already have correct accountType');
}

// ════════════════════════════════════════════════════════════
// FIX 4 — Normalize vitaRateMarkup to 0 on all transactions
// ════════════════════════════════════════════════════════════
console.log('\n💰 FIX 4 — Normalize vitaRateMarkup to 0');

const markupResult = await db.collection('transactions').updateMany(
  { 'fees.vitaRateMarkup': { $gt: 0 } },
  { $set: { 'fees.vitaRateMarkup': 0 } }
);
console.log(`  ✅ Normalized: ${markupResult.modifiedCount} transactions`);

// ════════════════════════════════════════════════════════════
// FIX 5 — Disable anomalous corridors (ar-co LLC, bo-eu LLC)
// ════════════════════════════════════════════════════════════
console.log('\n🚫 FIX 5 — Disable anomalous corridors');

const anomalousResult = await db.collection('transaction_configs').updateMany(
  {
    corridorId: { $in: ['ar-co', 'bo-eu'] },
    legalEntity: 'LLC'
  },
  { $set: { isActive: false } }
);
console.log(`  ✅ Disabled: ${anomalousResult.modifiedCount} anomalous corridors`);

// ════════════════════════════════════════════════════════════
// FIX 6 — Set payoutMethod='owlPay' for SpA Harbor corridors
// ════════════════════════════════════════════════════════════
console.log('\n🌐 FIX 6 — SpA Harbor corridors payoutMethod');

const spaHarborResult = await db.collection('transaction_configs').updateMany(
  {
    corridorId: { $in: ['cl-ae', 'cl-au', 'cl-cn', 'cl-eu', 'cl-gb'] },
    legalEntity: 'SpA'
  },
  { $set: { payoutMethod: 'owlPay' } }
);
console.log(`  ✅ Updated: ${spaHarborResult.modifiedCount} SpA Harbor corridors`);

// ════════════════════════════════════════════════════════════
// FIX 7 — bo-cn and bo-ng minAmountUSD = 30
// ════════════════════════════════════════════════════════════
console.log('\n📏 FIX 7 — OwlPay corridor minimums');

const minResult = await db.collection('transaction_configs').updateMany(
  { corridorId: { $in: ['bo-cn', 'bo-ng'] } },
  { $set: { minAmountUSD: 30, minAmountOrigin: 1 } }
);
console.log(`  ✅ Updated: ${minResult.modifiedCount} OwlPay corridors`);

// ════════════════════════════════════════════════════════════
// VERIFICATION REPORT
// ════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(60));
console.log('📋 VERIFICATION REPORT');
console.log('═'.repeat(60));

// Active corridors by entity
const corridorsByEntity = await db.collection('transaction_configs')
  .aggregate([
    { $match: { isActive: true } },
    { $group: {
      _id: '$legalEntity',
      count: { $sum: 1 },
      withBusinessSpread: {
        $sum: { $cond: [{ $ne: ['$businessAlytoCSpread', null] }, 1, 0] }
      }
    }}
  ]).toArray();

console.log('\nActive corridors by entity:');
corridorsByEntity.forEach(e =>
  console.log(`  ${e._id}: ${e.count} total, ${e.withBusinessSpread} with businessAlytoCSpread`)
);

// User accountType distribution
const usersByType = await db.collection('users')
  .aggregate([
    { $group: { _id: '$accountType', count: { $sum: 1 } } }
  ]).toArray();

console.log('\nUsers by accountType:');
usersByType.forEach(u =>
  console.log(`  ${u._id}: ${u.count}`)
);

// KYB status distribution
const usersByKyb = await db.collection('users')
  .aggregate([
    { $match: { kybStatus: { $ne: null } } },
    { $group: { _id: { kybStatus: '$kybStatus', accountType: '$accountType' }, count: { $sum: 1 } } }
  ]).toArray();

console.log('\nKYB status × accountType:');
usersByKyb.forEach(u =>
  console.log(`  kybStatus: ${u._id.kybStatus}, accountType: ${u._id.accountType} → ${u.count} users`)
);

// Transactions with vitaRateMarkup > 0
const markupCount = await db.collection('transactions')
  .countDocuments({ 'fees.vitaRateMarkup': { $gt: 0 } });
console.log(`\nTransactions with vitaRateMarkup > 0: ${markupCount} (should be 0)`);

console.log('\n' + '═'.repeat(60));
console.log('✅ Script completed successfully');
console.log('═'.repeat(60));

await mongoose.disconnect();
process.exit(0);
