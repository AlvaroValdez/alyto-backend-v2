/**
 * wipe-all-transactions.js
 *
 * ⚠️ DESTRUCTIVO — elimina collections `transactions` y `contacts`.
 *
 * Uso:
 *   node --env-file=.env scripts/wipe-all-transactions.js                  # dry-run (default)
 *   node --env-file=.env scripts/wipe-all-transactions.js --execute        # borra todo
 *   node --env-file=.env scripts/wipe-all-transactions.js --execute --only-transactions
 *   node --env-file=.env scripts/wipe-all-transactions.js --execute --only-contacts
 */

import mongoose from 'mongoose';

const MONGODB_URI    = process.env.MONGODB_URI;
const EXECUTE        = process.argv.includes('--execute');
const ONLY_TX        = process.argv.includes('--only-transactions');
const ONLY_CONTACTS  = process.argv.includes('--only-contacts');
const WIPE_TX        = !ONLY_CONTACTS;
const WIPE_CONTACTS  = !ONLY_TX;

if (!MONGODB_URI) {
  console.error('MONGODB_URI no configurada');
  process.exit(1);
}

await mongoose.connect(MONGODB_URI);
console.log('Conectado a DB:', mongoose.connection.db.databaseName);

async function summarizeAndMaybeWipe(collectionName, statusField = null, entityField = null) {
  const col   = mongoose.connection.collection(collectionName);
  const total = await col.countDocuments({});
  console.log(`\n── Collection: ${collectionName} ──`);
  console.log(`  Total documentos: ${total}`);

  if (total === 0) {
    console.log('  Vacía. Nada que hacer.');
    return 0;
  }

  if (statusField) {
    const byStatus = await col.aggregate([
      { $group: { _id: `$${statusField}`, count: { $sum: 1 } } },
      { $sort:  { count: -1 } },
    ]).toArray();
    console.log(`  Por ${statusField}:`);
    byStatus.forEach(s => console.log(`    ${(s._id ?? '(null)').toString().padEnd(28)} ${s.count}`));
  }
  if (entityField) {
    const byEntity = await col.aggregate([
      { $group: { _id: `$${entityField}`, count: { $sum: 1 } } },
      { $sort:  { count: -1 } },
    ]).toArray();
    console.log(`  Por ${entityField}:`);
    byEntity.forEach(s => console.log(`    ${(s._id ?? '(null)').toString().padEnd(8)} ${s.count}`));
  }

  if (!EXECUTE) return total;

  console.log(`  ⚠️  Ejecutando deleteMany({})...`);
  const result = await col.deleteMany({});
  console.log(`  ✅ Eliminadas: ${result.deletedCount} de ${collectionName}`);
  return result.deletedCount;
}

if (WIPE_TX) {
  await summarizeAndMaybeWipe('transactions', 'status', 'legalEntity');
}
if (WIPE_CONTACTS) {
  await summarizeAndMaybeWipe('contacts', null, 'destinationCountry');
}

if (!EXECUTE) {
  console.log('\n[DRY RUN] No se eliminó nada.');
  console.log('Para ejecutar: agregar flag --execute');
  console.log('Opciones: --only-transactions | --only-contacts');
}

await mongoose.disconnect();
console.log('\nListo.');
