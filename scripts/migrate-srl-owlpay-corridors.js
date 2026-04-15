/**
 * migrate-srl-owlpay-corridors.js
 *
 * Activa/desactiva corredores SRL OwlPay según cobertura confirmada de Harbor.
 *
 * ACTIVOS (Harbor confirmado):
 *   bo-cn → CNY ✅
 *   bo-ng → NGN ✅
 *
 * INACTIVOS (Harbor upcoming o no confirmado):
 *   bo-au, bo-gb, bo-jp, bo-sg, bo-za
 *
 * Uso:
 *   node --env-file=.env scripts/migrate-srl-owlpay-corridors.js
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('❌  MONGODB_URI no definida en el entorno.');
  process.exit(1);
}

const INACTIVE_IDS = ['bo-au', 'bo-gb', 'bo-jp', 'bo-sg', 'bo-za'];
const ACTIVE_IDS   = ['bo-cn', 'bo-ng'];

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('✅  Conectado a MongoDB');

  const coll = mongoose.connection.collection('transactionconfigs');
  const now  = new Date();

  const offResult = await coll.updateMany(
    { corridorId: { $in: INACTIVE_IDS } },
    {
      $set: {
        isActive:   false,
        updatedAt:  now,
        adminNotes: 'Deactivated: Harbor local currency support unconfirmed. Reactivate when Harbor confirms coverage.',
      },
    },
  );
  console.log(`🔻  Desactivados ${offResult.modifiedCount} corredores: ${INACTIVE_IDS.join(', ')}`);

  const onResult = await coll.updateMany(
    { corridorId: { $in: ACTIVE_IDS } },
    {
      $set: {
        isActive:   true,
        updatedAt:  now,
        adminNotes: 'Active: Harbor confirmed CNY/NGN local currency support.',
      },
    },
  );
  console.log(`🟢  Activados   ${onResult.modifiedCount} corredores: ${ACTIVE_IDS.join(', ')}`);

  const summary = await coll.find(
    { corridorId: { $in: [...INACTIVE_IDS, ...ACTIVE_IDS] } },
    { projection: { corridorId: 1, isActive: 1, payoutMethod: 1, destinationCurrency: 1 } },
  ).toArray();

  console.log('\n📋  Estado final:');
  for (const c of summary) {
    console.log(`   ${c.corridorId.padEnd(8)} ${c.destinationCurrency?.padEnd(4) ?? '—   '} ${c.payoutMethod?.padEnd(12) ?? '—           '} ${c.isActive ? '🟢 active' : '🔻 inactive'}`);
  }

  await mongoose.disconnect();
  console.log('\n✅  Migración completada.');
}

run().catch(err => {
  console.error('❌  Error en la migración:', err);
  process.exit(1);
});
