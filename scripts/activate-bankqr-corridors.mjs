#!/usr/bin/env node
/**
 * activate-bankqr-corridors.mjs — Cambia el payin de los corredores SRL de
 * `manual` a `bankQr` (BEC QR Connect), que es lo que habilita la confirmación
 * automática del pago sin comprobante ni admin.
 *
 * Regla aplicada: SOLO corredores con legalEntity='SRL' Y originCurrency='BOB'.
 *   - El QR de BEC abona a BEC_ACCOUNT_CREDIT, que es la cuenta de AV Finance SRL.
 *     Un corredor de otra entidad (LLC) cobrando a esa cuenta mezclaría entidades.
 *   - Un corredor con origen ≠ BOB (p.ej. cl-bo, que cobra CLP en Chile) no puede
 *     cobrarse con un QR boliviano.
 *
 * Dry-run por defecto. Para escribir: --apply
 * Para revertir:                      --revert [--apply]
 *
 *   node scripts/activate-bankqr-corridors.mjs              # muestra qué haría
 *   node scripts/activate-bankqr-corridors.mjs --apply      # aplica
 *   node scripts/activate-bankqr-corridors.mjs --revert --apply
 *
 * Requiere además, para que el QR sea real (si faltan, el servicio cae a mock):
 *   BEC_USERNAME · BEC_PASSWORD · BEC_AES_KEY · BEC_BASE_URL · BEC_ACCOUNT_CREDIT
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const args   = process.argv.slice(2);
const apply  = args.includes('--apply');
const revert = args.includes('--revert');
const bankId = process.env.WALLET_DEPOSIT_BANK_ID ?? 'bec';

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('❌ Falta MONGODB_URI'); process.exit(1); }

const dbName = uri.match(/\/([^/?]+)\?/)?.[1] ?? '(desconocida)';
const isProd = !/staging|test|dev/i.test(dbName);

console.log(`\n=== ${revert ? 'REVERTIR a manual' : 'ACTIVAR bankQr'} — corredores SRL ===`);
console.log(`Base de datos : ${dbName}${isProd ? '   ⚠️  PRODUCCIÓN' : ''}`);
console.log(`Modo          : ${apply ? 'APPLY (escribe)' : 'DRY-RUN (no escribe)'}`);

if (isProd && apply && !args.includes('--i-know-this-is-production')) {
  console.error('\n❌ La base parece de PRODUCCIÓN. Repetí con --i-know-this-is-production para confirmar.');
  process.exit(1);
}

await mongoose.connect(uri);
const col = mongoose.connection.db.collection('transaction_configs');

// El filtro es explícito por entidad + moneda de origen: nunca por "todos los manual".
const filter = revert
  ? { legalEntity: 'SRL', originCurrency: 'BOB', payinMethod: 'bankQr' }
  : { legalEntity: 'SRL', originCurrency: 'BOB', payinMethod: 'manual' };

const targets = await col.find(filter, {
  projection: { corridorId: 1, isActive: 1, payinMethod: 1, bankQrConfig: 1 },
}).toArray();

if (targets.length === 0) {
  console.log('\nNada que cambiar (ningún corredor coincide con el filtro).');
  await mongoose.disconnect();
  process.exit(0);
}

console.log(`\nCorredores afectados: ${targets.length} (activos: ${targets.filter(t => t.isActive).length})`);
for (const t of targets) {
  const flag = t.isActive ? '🟢' : '🔻';
  console.log(`  ${flag} ${t.corridorId.padEnd(12)} ${t.payinMethod} → ${revert ? 'manual' : `bankQr (${bankId})`}`);
}

if (!apply) {
  console.log('\n(DRY-RUN) Nada se escribió. Repetí con --apply para aplicar.');
  await mongoose.disconnect();
  process.exit(0);
}

const update = revert
  ? { $set: { payinMethod: 'manual' }, $unset: { bankQrConfig: '' } }
  : { $set: { payinMethod: 'bankQr', bankQrConfig: { bankId } } };

const r = await col.updateMany(filter, update);
console.log(`\n✅ Actualizados: ${r.modifiedCount}/${targets.length}`);

const check = await col.countDocuments({ legalEntity: 'SRL', originCurrency: 'BOB', payinMethod: 'bankQr' });
console.log(`Verificación: ${check} corredores SRL/BOB quedaron en bankQr.`);

await mongoose.disconnect();
