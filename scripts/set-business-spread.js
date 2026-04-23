/**
 * set-business-spread.js — Migración GAP 2
 *
 * Establece businessAlytoCSpread = 0.5 en todos los corredores activos
 * que aún no tienen el campo configurado (null).
 *
 * Uso:
 *   node scripts/set-business-spread.js
 *   node scripts/set-business-spread.js --dry-run   (solo muestra, no modifica)
 *
 * Reversión:
 *   db.transactionconfigs.updateMany({}, { $set: { businessAlytyCSpread: null } })
 */

import mongoose from 'mongoose';
import dotenv   from 'dotenv';

dotenv.config();

const BUSINESS_SPREAD = 0.5; // 0.5%

async function run() {
  const isDry = process.argv.includes('--dry-run');
  const uri   = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌  MONGODB_URI no definido en .env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('✅  Conectado a MongoDB');

  const db         = mongoose.connection.db;
  const collection = db.collection('transactionconfigs');

  const targets = await collection.find({ isActive: true, businessAlytoCSpread: null }).toArray();

  if (targets.length === 0) {
    console.log('ℹ️   No hay corredores activos con businessAlytyCSpread = null. Nada que migrar.');
    await mongoose.disconnect();
    return;
  }

  console.log(`📋  Corredores a actualizar (${targets.length}):`);
  for (const c of targets) {
    console.log(`  • ${c.corridorId}  alytoCSpread=${c.alytoCSpread}%  → businessAlytyCSpread=${BUSINESS_SPREAD}%`);
  }

  if (isDry) {
    console.log('\n🔍  Dry-run — no se aplicaron cambios.');
    await mongoose.disconnect();
    return;
  }

  const result = await collection.updateMany(
    { isActive: true, businessAlytoCSpread: null },
    { $set: { businessAlytoCSpread: BUSINESS_SPREAD } },
  );

  console.log(`\n✅  Migración completa. Modificados: ${result.modifiedCount} corredores.`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌  Error en migración:', err.message);
  process.exit(1);
});
