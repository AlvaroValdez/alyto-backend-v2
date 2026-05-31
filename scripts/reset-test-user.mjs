/**
 * reset-test-user.mjs — Resetea un usuario de pruebas a cuenta PERSONAL.
 *
 * Devuelve al usuario a estado personal para reiniciar pruebas del flujo Business:
 *   - accountType  → 'personal'
 *   - kybStatus    → 'not_started'
 *   - businessProfileId → unset
 *   - elimina su BusinessProfile asociado (si existe)
 *
 * ⚠️ El .env local apunta a PRODUCCIÓN (alyto-v2). Este script deriva
 *    automáticamente la URI de staging (alyto-v2-staging) y NUNCA toca prod
 *    salvo target explícito 'production'.
 *
 * Uso:
 *   node --env-file=.env scripts/reset-test-user.mjs <email> [staging|production]
 *   node --env-file=.env scripts/reset-test-user.mjs test@avfinance.net staging
 */

import mongoose from 'mongoose';

const EMAIL  = process.argv[2];
const TARGET = process.argv[3] ?? 'staging';

if (!EMAIL) {
  console.error('❌ Uso: node --env-file=.env scripts/reset-test-user.mjs <email> [staging|production]');
  process.exit(1);
}
if (!['staging', 'production'].includes(TARGET)) {
  console.error('❌ TARGET debe ser "staging" o "production"');
  process.exit(1);
}

const PROD_URI = process.env.MONGODB_URI;
if (!PROD_URI) {
  console.error('❌ MONGODB_URI no definida en .env');
  process.exit(1);
}

const URI = TARGET === 'staging'
  ? PROD_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')
  : PROD_URI;

if (TARGET === 'staging' && URI === PROD_URI) {
  console.error('❌ No se pudo derivar la URI de staging. Verifica que MONGODB_URI contenga /alyto-v2');
  process.exit(1);
}

await mongoose.connect(URI);
const dbName = mongoose.connection.db.databaseName;

// ── Guard de seguridad: el nombre de la DB debe coincidir con el TARGET ──────
if (TARGET === 'staging'    && dbName !== 'alyto-v2-staging') {
  console.error(`❌ INCONSISTENCIA: TARGET=staging pero DB es "${dbName}" (esperado: alyto-v2-staging)`);
  process.exit(1);
}
if (TARGET === 'production' && dbName !== 'alyto-v2') {
  console.error(`❌ INCONSISTENCIA: TARGET=production pero DB es "${dbName}" (esperado: alyto-v2)`);
  process.exit(1);
}

console.log(`\n✅ Conectado a ${TARGET.toUpperCase()} — DB: "${dbName}"`);

const users    = mongoose.connection.collection('users');
const profiles = mongoose.connection.collection('business_profiles');

const user = await users.findOne({ email: EMAIL.toLowerCase() });
if (!user) {
  console.error(`❌ Usuario "${EMAIL}" no encontrado en ${dbName}`);
  await mongoose.disconnect();
  process.exit(1);
}

// Borrar BusinessProfile asociado (por userId y por businessProfileId)
const delById  = user.businessProfileId
  ? await profiles.deleteOne({ _id: user.businessProfileId })
  : { deletedCount: 0 };
const delByRef = await profiles.deleteMany({ userId: user._id });
const borrados = (delById.deletedCount ?? 0) + (delByRef.deletedCount ?? 0);

// Resetear el usuario a personal
await users.updateOne(
  { _id: user._id },
  {
    $set:   { accountType: 'personal', kybStatus: 'not_started' },
    $unset: { businessProfileId: '' },
  },
);

console.log(`\n🔄 Reset OK (${dbName})`);
console.log(`   email             : ${EMAIL}`);
console.log(`   accountType       : personal`);
console.log(`   kybStatus         : not_started`);
console.log(`   businessProfileId : (unset)`);
console.log(`   perfiles borrados : ${borrados}`);

await mongoose.disconnect();
console.log('\n✅ Listo para reiniciar pruebas Business.\n');
