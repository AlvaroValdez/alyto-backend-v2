/**
 * migrate-vita-corridors-au-cnusd.js
 *
 * Migración de routing de corredores SRL:
 *   1. bo-au  → cambia de owlPay (inactivo) a vitaWallet (BSB routing_number, AUD)
 *   2. bo-cn-usd → nuevo corredor CN USD via Vita (SWIFT, sin mínimo $600 Harbor)
 *
 * Uso:
 *   node --env-file=.env scripts/migrate-vita-corridors-au-cnusd.js
 *
 * Idempotente — puede correrse múltiples veces sin efecto secundario.
 */

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('❌ MONGODB_URI no definido'); process.exit(1); }

await mongoose.connect(MONGODB_URI);
const db = mongoose.connection.db;
const col = db.collection('transaction_configs');

console.log('\n🔧 Migrando corredores Vita SRL...\n');

// ── 1. bo-au: owlPay → vitaWallet ────────────────────────────────────────────

const auResult = await col.updateOne(
  { corridorId: 'bo-au' },
  {
    $set: {
      payoutMethod:         'vitaWallet',
      fallbackPayoutMethod: 'owlPay',
      destinationCurrency:  'AUD',
      minAmountOrigin:      300,
      isActive:             true,
      adminNotes:           'Corredor BO→AU. Payin manual SRL. Payout Vita clave "au" (BSB routing_number, sin SWIFT). Reemplaza Harbor inactivo. Configurar tasa BOB/USDC con PATCH /api/v1/admin/corridors/bo-au/rate',
    },
  },
  { upsert: false },
);

if (auResult.matchedCount === 0) {
  console.log('⚠️  bo-au no encontrado en BD — se creará con el seed script. Verifica que seedCorredores.js esté actualizado.');
} else if (auResult.modifiedCount > 0) {
  console.log('✅ bo-au → payoutMethod cambiado a vitaWallet (fallback: owlPay)');
} else {
  console.log('ℹ️  bo-au ya estaba configurado correctamente (sin cambios)');
}

// ── 2. bo-cn-usd: nuevo corredor Vita China USD ───────────────────────────────

const cnUsdDoc = {
  corridorId:             'bo-cn-usd',
  originCountry:          'BO',
  destinationCountry:     'CN',
  originCurrency:         'BOB',
  destinationCurrency:    'USD',
  payinMethod:            'manual',
  payoutMethod:           'vitaWallet',
  fallbackPayoutMethod:   null,
  manualExchangeRate:     0,
  stellarAsset:           'USDC',
  alytoCSpread:           2,
  businessAlytoCSpread:   0.5,
  fixedFee:               5,
  payinFeePercent:        0,
  payoutFeeFixed:         0,
  profitRetentionPercent: 1,
  minAmountOrigin:        300,
  maxAmountOrigin:        null,
  legalEntity:            'SRL',
  routingScenario:        'C',
  isActive:               true,
  adminNotes:             'Corredor BO→CN USD. Payin manual SRL. Payout Vita clave "cnusd" (SWIFT internacional). Sin mínimo $600 de Harbor. bo-cn (CNY) permanece en Harbor. Configurar tasa BOB/USDC con PATCH /api/v1/admin/corridors/bo-cn-usd/rate',
};

// bo-cn-usd puede existir como corredor Harbor inactivo — sobreescribir con Vita
const cnUsdResult = await col.updateOne(
  { corridorId: 'bo-cn-usd' },
  { $set: cnUsdDoc },
  { upsert: true },
);

if (cnUsdResult.upsertedCount > 0) {
  console.log('✅ bo-cn-usd → creado (Vita cnusd, China USD vía SWIFT)');
} else if (cnUsdResult.modifiedCount > 0) {
  console.log('✅ bo-cn-usd → actualizado de Harbor a Vita (cnusd, China USD vía SWIFT)');
} else {
  console.log('ℹ️  bo-cn-usd ya estaba configurado correctamente (sin cambios)');
}

// ── Resumen ───────────────────────────────────────────────────────────────────

console.log('\n📋 Estado final de corredores afectados:');

const auDoc    = await col.findOne({ corridorId: 'bo-au'     }, { projection: { corridorId: 1, payoutMethod: 1, fallbackPayoutMethod: 1, isActive: 1 } });
const cnDoc    = await col.findOne({ corridorId: 'bo-cn'     }, { projection: { corridorId: 1, payoutMethod: 1, destinationCurrency: 1, isActive: 1 } });
const cnUsdDoc2= await col.findOne({ corridorId: 'bo-cn-usd' }, { projection: { corridorId: 1, payoutMethod: 1, destinationCurrency: 1, isActive: 1 } });

const fmt = d => d
  ? `${d.corridorId.padEnd(12)} ${(d.payoutMethod ?? '?').padEnd(12)} fallback=${d.fallbackPayoutMethod ?? 'null'} currency=${d.destinationCurrency ?? '?'} active=${d.isActive}`
  : '(no encontrado)';

console.log('  ' + fmt(auDoc));
console.log('  ' + fmt(cnDoc));
console.log('  ' + fmt(cnUsdDoc2));

console.log('\n✅ Migración completa.\n');

await mongoose.disconnect();
process.exit(0);
