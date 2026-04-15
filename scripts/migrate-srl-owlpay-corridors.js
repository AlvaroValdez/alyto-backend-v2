/**
 * migrate-srl-owlpay-corridors.js
 *
 * Activa/desactiva corredores SRL OwlPay según cobertura confirmada de Harbor.
 * Idempotente: re-ejecutar produce el mismo estado.
 *
 * ACTIVOS (Harbor confirmado):
 *   bo-cn → CNY ✅
 *   bo-ng → NGN ✅
 *
 * INACTIVOS (Harbor upcoming, no confirmado, o duplicados legacy):
 *   bo-au, bo-gb, bo-jp, bo-sg, bo-za  → cobertura Harbor no confirmada
 *   bo-cn-srl, bo-gb-srl               → duplicados legacy (usar canónico)
 *   bo-eu-srl, bo-ae-srl               → Harbor EUR/AED upcoming Q1 2026
 *   bo-us-owlpay                        → reactivar cuando LLC esté en producción
 *
 * Uso:
 *   node -r dotenv/config scripts/migrate-srl-owlpay-corridors.js
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('❌  MONGODB_URI no definida en el entorno.');
  process.exit(1);
}

const INACTIVE_BUCKETS = [
  {
    ids:   ['bo-au', 'bo-gb', 'bo-jp', 'bo-sg', 'bo-za'],
    note:  'Deactivated: Harbor local currency support unconfirmed. Reactivate when Harbor confirms coverage.',
  },
  {
    ids:   ['bo-cn-srl', 'bo-gb-srl'],
    note:  'Deactivated: duplicate of bo-cn/bo-gb. Use canonical corridor.',
  },
  {
    ids:   ['bo-eu-srl', 'bo-ae-srl'],
    note:  'Deactivated: Harbor EUR/AED support upcoming Q1 2026. Reactivate when confirmed.',
  },
  {
    ids:   ['bo-us-owlpay'],
    note:  'Deactivated: SRL→US not active (0 transactions). Reactivate when LLC corridor launches.',
  },
];

const ACTIVE_IDS = ['bo-cn', 'bo-ng'];

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('✅  Conectado a MongoDB');

  const coll = mongoose.connection.collection('transaction_configs');
  const now  = new Date();

  for (const bucket of INACTIVE_BUCKETS) {
    const res = await coll.updateMany(
      { corridorId: { $in: bucket.ids } },
      { $set: { isActive: false, updatedAt: now, adminNotes: bucket.note } },
    );
    console.log(`🔻  Desactivados ${res.modifiedCount}/${bucket.ids.length}: ${bucket.ids.join(', ')}`);
  }

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
  console.log(`🟢  Activados   ${onResult.modifiedCount}/${ACTIVE_IDS.length}: ${ACTIVE_IDS.join(', ')}`);

  const allIds = [...INACTIVE_BUCKETS.flatMap(b => b.ids), ...ACTIVE_IDS];
  const summary = await coll.find(
    { corridorId: { $in: allIds } },
    { projection: { corridorId: 1, isActive: 1, payoutMethod: 1, destinationCurrency: 1 } },
  ).toArray();

  console.log('\n📋  Estado final (corredores gestionados):');
  for (const c of summary.sort((a, b) => a.corridorId.localeCompare(b.corridorId))) {
    console.log(`   ${c.corridorId.padEnd(15)} ${c.destinationCurrency?.padEnd(4) ?? '—   '} ${c.payoutMethod?.padEnd(12) ?? '—           '} ${c.isActive ? '🟢 active' : '🔻 inactive'}`);
  }

  console.log('\n📋  Todos los SRL+owlPay (auditoría):');
  const allSrlOwlPay = await coll.find(
    { legalEntity: 'SRL', payoutMethod: 'owlPay' },
    { projection: { corridorId: 1, isActive: 1, destinationCountry: 1, destinationCurrency: 1 } },
  ).sort({ corridorId: 1 }).toArray();
  for (const c of allSrlOwlPay) {
    console.log(`   ${c.corridorId.padEnd(15)} ${c.destinationCountry?.padEnd(3) ?? '—'} ${c.destinationCurrency?.padEnd(4) ?? '—   '} ${c.isActive ? '🟢 active' : '🔻 inactive'}`);
  }

  await mongoose.disconnect();
  console.log('\n✅  Migración completada.');
}

run().catch(err => {
  console.error('❌  Error en la migración:', err);
  process.exit(1);
});
