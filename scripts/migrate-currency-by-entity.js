/**
 * migrate-currency-by-entity.js
 *
 * Corrige preferences.currency para todos los usuarios existentes
 * según su legalEntity:
 *   SRL → BOB
 *   SpA → CLP
 *   LLC → USD
 *
 * SOLO actualiza usuarios cuya moneda actual NO coincide con la esperada
 * (evita sobrescribir elecciones explícitas correctas).
 *
 * Uso:
 *   node --env-file=.env scripts/migrate-currency-by-entity.js
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('❌  MONGODB_URI no definida en el entorno.');
  process.exit(1);
}

const ENTITY_CURRENCY_MAP = { SpA: 'CLP', SRL: 'BOB', LLC: 'USD' };

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('✅  Conectado a MongoDB');

  const db   = mongoose.connection.db;
  const col  = db.collection('users');

  // 1. Contar el estado actual
  const total = await col.countDocuments({});
  console.log(`📊  Total usuarios: ${total}`);

  let updated = 0;
  let skipped = 0;

  for (const [entity, correctCurrency] of Object.entries(ENTITY_CURRENCY_MAP)) {
    // Usuarios de esta entidad cuya moneda ya está mal o no está definida
    const filter = {
      legalEntity: entity,
      $or: [
        { 'preferences.currency': { $exists: false } },
        { 'preferences.currency': { $ne: correctCurrency } },
      ],
    };

    const preview = await col.find(filter)
      .project({ email: 1, legalEntity: 1, 'preferences.currency': 1 })
      .toArray();

    if (preview.length === 0) {
      console.log(`ℹ️   ${entity}: ningún usuario necesita corrección.`);
      skipped++;
      continue;
    }

    console.log(`\n🔧  ${entity} → ${correctCurrency} (${preview.length} usuarios):`);
    for (const u of preview) {
      console.log(`    ${u.email}  [moneda actual: ${u.preferences?.currency ?? 'no definida'}]`);
    }

    const result = await col.updateMany(filter, {
      $set: { 'preferences.currency': correctCurrency },
    });

    console.log(`    ✅  Actualizados: ${result.modifiedCount}`);
    updated += result.modifiedCount;
  }

  console.log(`\n🏁  Migración completada.`);
  console.log(`    Actualizados: ${updated}`);
  console.log(`    Sin cambios:  ${skipped} entidades ya correctas`);

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌  Error en migración:', err.message);
  process.exit(1);
});
