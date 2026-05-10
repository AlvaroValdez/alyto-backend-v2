/**
 * cleanup-harbor-test-transactions.js
 *
 * Elimina transacciones de test de corredores Harbor (owlPay).
 * Solo elimina transacciones que NO estén en 'completed'.
 *
 * Usage: node --env-file=.env scripts/cleanup-harbor-test-transactions.js
 *        node --env-file=.env scripts/cleanup-harbor-test-transactions.js --dry-run
 *
 * ⚠️  NUNCA ejecutar en producción.
 */

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;
const DRY_RUN     = process.argv.includes('--dry-run');

if (!MONGODB_URI) {
  console.error('MONGODB_URI not set');
  process.exit(1);
}

if (MONGODB_URI.includes('prod') || process.env.NODE_ENV === 'production') {
  if (process.env.FORCE_CLEANUP !== 'true') {
    console.error('SAFETY: Rechazado en producción. Set FORCE_CLEANUP=true para forzar.');
    process.exit(1);
  }
}

await mongoose.connect(MONGODB_URI);
console.log('Conectado a:', mongoose.connection.db.databaseName);

const col = mongoose.connection.collection('transactions');

// Corredores Harbor activos: bo-cn, bo-ng (+ variantes USD)
const query = {
  corridorCode: { $in: ['bo-cn', 'bo-ng', 'bo-cn-usd'] },
  status:       { $ne: 'completed' },
};

const count  = await col.countDocuments(query);
const sample = await col.find(query).limit(5).project({
  alytoTransactionId: 1, status: 1, corridorCode: 1, createdAt: 1,
}).toArray();

console.log(`\nTransacciones Harbor no-completed encontradas: ${count}`);
sample.forEach(t => {
  console.log(` - ${t.alytoTransactionId ?? t._id} | ${t.status} | ${t.corridorCode} | ${t.createdAt?.toISOString()}`);
});

if (count === 0) {
  console.log('Nada que eliminar.');
  await mongoose.disconnect();
  process.exit(0);
}

if (DRY_RUN) {
  console.log('\n[DRY RUN] No se eliminó nada. Quitar --dry-run para ejecutar.');
  await mongoose.disconnect();
  process.exit(0);
}

const result = await col.deleteMany(query);
console.log(`\nEliminadas: ${result.deletedCount} transacciones Harbor de test.`);

await mongoose.disconnect();
console.log('Listo.');
