/**
 * wipe-all-transactions.js
 *
 * ⚠️ DESTRUCTIVO — elimina TODA la collection `transactions`.
 *
 * Uso:
 *   node --env-file=.env scripts/wipe-all-transactions.js              # dry-run (muestra conteo)
 *   node --env-file=.env scripts/wipe-all-transactions.js --execute    # borra
 */

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;
const EXECUTE     = process.argv.includes('--execute');

if (!MONGODB_URI) {
  console.error('MONGODB_URI no configurada');
  process.exit(1);
}

await mongoose.connect(MONGODB_URI);
console.log('Conectado a DB:', mongoose.connection.db.databaseName);

const col   = mongoose.connection.collection('transactions');
const total = await col.countDocuments({});

console.log(`\nTotal de transacciones en la collection: ${total}`);

if (total === 0) {
  console.log('Collection ya vacía. Nada que hacer.');
  await mongoose.disconnect();
  process.exit(0);
}

const byStatus = await col.aggregate([
  { $group: { _id: '$status', count: { $sum: 1 } } },
  { $sort:  { count: -1 } },
]).toArray();

console.log('\nDistribución por status:');
byStatus.forEach(s => console.log(`  ${(s._id ?? '(sin status)').padEnd(28)} ${s.count}`));

const byEntity = await col.aggregate([
  { $group: { _id: '$legalEntity', count: { $sum: 1 } } },
  { $sort:  { count: -1 } },
]).toArray();

console.log('\nDistribución por legalEntity:');
byEntity.forEach(s => console.log(`  ${(s._id ?? '(sin entidad)').padEnd(8)} ${s.count}`));

if (!EXECUTE) {
  console.log('\n[DRY RUN] No se eliminó nada.');
  console.log('Para ejecutar el borrado: agregar flag --execute');
  await mongoose.disconnect();
  process.exit(0);
}

console.log('\n⚠️  Ejecutando deleteMany({})...');
const result = await col.deleteMany({});
console.log(`✅ Eliminadas: ${result.deletedCount} transacciones`);

await mongoose.disconnect();
console.log('Listo.');
