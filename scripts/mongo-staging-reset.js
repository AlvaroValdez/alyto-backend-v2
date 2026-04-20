/**
 * mongo-staging-reset.js
 *
 * Staging data reset script — safe to run multiple times.
 * Fixes tokenVersion drift and creates test notifications.
 *
 * Usage: node --env-file=.env scripts/mongo-staging-reset.js
 *
 * ⚠️  NEVER run on production VPS.
 */

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not set');
  process.exit(1);
}

if (MONGODB_URI.includes('prod') || process.env.NODE_ENV === 'production') {
  // Extra safety check — refuse to run against prod
  if (process.env.FORCE_STAGING_RESET !== 'true') {
    console.error('❌ SAFETY: This script refuses to run against production.');
    console.error('   If you really need this, set FORCE_STAGING_RESET=true');
    process.exit(1);
  }
}

await mongoose.connect(MONGODB_URI);
console.log('✅ Connected to MongoDB:', mongoose.connection.db.databaseName);
console.log('');

const db = mongoose.connection.db;

// ══════════════════════════════════════════════════════════
// RESET 1 — tokenVersion: reset ALL users to 0
// ══════════════════════════════════════════════════════════
console.log('🔄 RESET 1 — Resetting tokenVersion for all users...');
const tvResult = await db.collection('users').updateMany(
  {},
  { $set: { tokenVersion: 0 } }
);
console.log(`   ✅ Updated ${tvResult.modifiedCount} users → tokenVersion: 0`);
console.log('');

// ══════════════════════════════════════════════════════════
// RESET 2 — Deactivate duplicate SRL OwlPay corridors
// ══════════════════════════════════════════════════════════
console.log('🔄 RESET 2 — Deactivating duplicate/upcoming SRL OwlPay corridors...');
const duplicates = ['bo-cn-srl', 'bo-gb-srl', 'bo-eu-srl', 'bo-ae-srl',
                    'bo-au', 'bo-gb', 'bo-jp', 'bo-sg', 'bo-za', 'bo-us-owlpay'];
const corrResult = await db.collection('transaction_configs').updateMany(
  { corridorId: { $in: duplicates } },
  { $set: { isActive: false, updatedAt: new Date() } }
);
console.log(`   ✅ Deactivated ${corrResult.modifiedCount} corridors`);

// Activate confirmed OwlPay corridors
const activeOwlPay = ['bo-cn', 'bo-ng'];
const activResult = await db.collection('transaction_configs').updateMany(
  { corridorId: { $in: activeOwlPay } },
  { $set: { isActive: true, updatedAt: new Date() } }
);
console.log(`   ✅ Activated ${activResult.modifiedCount} OwlPay corridors (bo-cn, bo-ng)`);
console.log('');

// ══════════════════════════════════════════════════════════
// RESET 3 — Migrate notifications for all transactions
// ══════════════════════════════════════════════════════════
console.log('🔄 RESET 3 — Migrating notifications for existing transactions...');

const transactions = await db.collection('transactions').find({
  status: { $nin: ['pending', 'initiated'] }
}).toArray();

console.log(`   Found ${transactions.length} transactions to check`);

let created = 0;
let skipped = 0;

for (const tx of transactions) {
  const userId = tx.userId;
  const txId = tx.alytoTransactionId;
  if (!userId || !txId) { skipped++; continue; }

  // Check if notification already exists
  const existing = await db.collection('notifications').findOne({
    transactionId: txId
  });
  if (existing) { skipped++; continue; }

  // Determine notification based on status
  let title, body, type = 'transfer';

  if (tx.status === 'completed') {
    title = '¡Dinero entregado! ✓';
    body = `Tu transferencia fue completada exitosamente.`;
  } else if (tx.status === 'failed') {
    title = 'Transferencia no completada';
    body = 'Tu transferencia no pudo completarse. Contáctanos.';
  } else if (['payin_confirmed', 'payin_completed', 'processing',
               'in_transit', 'payout_pending', 'payout_sent'].includes(tx.status)) {
    title = 'Pago recibido ✓';
    body = 'Recibimos tu pago. Tu transferencia está siendo procesada.';
  } else {
    title = '¡Transferencia iniciada! 🚀';
    body = 'Tu transferencia fue creada. Te avisaremos cuando recibamos tu pago.';
  }

  await db.collection('notifications').insertOne({
    userId: userId,
    title,
    body,
    type,
    transactionId: txId,
    read: false,
    readAt: null,
    createdAt: tx.createdAt ?? new Date(),
    updatedAt: new Date(),
  });
  created++;
}

console.log(`   ✅ Created: ${created} notifications | Skipped: ${skipped} (already existed)`);
console.log('');

// ══════════════════════════════════════════════════════════
// RESET 4 — Report current state
// ══════════════════════════════════════════════════════════
console.log('📊 CURRENT STATE:');

const userCount = await db.collection('users').countDocuments();
const usersWithToken0 = await db.collection('users').countDocuments({ tokenVersion: 0 });
console.log(`   Users: ${userCount} total, ${usersWithToken0} with tokenVersion=0`);

const activeCorridors = await db.collection('transaction_configs')
  .countDocuments({ isActive: true, legalEntity: 'SRL' });
console.log(`   SRL active corridors: ${activeCorridors}`);

const notifCount = await db.collection('notifications').countDocuments();
console.log(`   Total notifications: ${notifCount}`);

const txCount = await db.collection('transactions').countDocuments();
console.log(`   Total transactions: ${txCount}`);

console.log('');
console.log('✅ Staging reset complete. Users must log in again to get fresh tokens.');

await mongoose.disconnect();
process.exit(0);
