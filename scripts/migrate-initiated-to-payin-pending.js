/**
 * migrate-initiated-to-payin-pending.js
 *
 * Backfill: status 'initiated' → 'payin_pending' para el corredor SRL.
 * Motivo: unificación del estado de payin pendiente. El enum 'initiated'
 * quedaba huérfano del filtro "Accionables" del admin Ledger, ocultando
 * transacciones SRL recién creadas hasta que el usuario subía comprobante.
 *
 * Idempotente — sólo actualiza documentos que aún tengan status 'initiated'.
 *
 * Uso (Node 20.6+):
 *   node --env-file=.env scripts/migrate-initiated-to-payin-pending.js
 *
 * Uso (Node < 20.6):
 *   node -r dotenv/config scripts/migrate-initiated-to-payin-pending.js
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

const filter = { status: 'initiated', legalEntity: 'SRL' };

const before = await db.collection('transactions').countDocuments(filter);
console.log(`🔍 Transacciones SRL con status='initiated': ${before}`);

if (before === 0) {
  console.log('Nada que migrar.');
  await mongoose.disconnect();
  process.exit(0);
}

const result = await db.collection('transactions').updateMany(
  filter,
  {
    $set: {
      status:    'payin_pending',
      updatedAt: new Date(),
    },
  },
);

console.log(`📊 matched: ${result.matchedCount} | modified: ${result.modifiedCount}`);

const sample = await db.collection('transactions')
  .find({ legalEntity: 'SRL', status: 'payin_pending' })
  .sort({ updatedAt: -1 })
  .limit(3)
  .project({ alytoTransactionId: 1, status: 1, updatedAt: 1 })
  .toArray();

console.log('Muestra (últimas 3 payin_pending SRL):');
for (const tx of sample) {
  console.log(`   ${tx.alytoTransactionId} → ${tx.status} @ ${tx.updatedAt?.toISOString?.() ?? tx.updatedAt}`);
}

console.log('');
console.log('✅ Migración completa.');
await mongoose.disconnect();
process.exit(0);
