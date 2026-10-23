#!/usr/bin/env node
/**
 * baja-cuenta-duplicada.mjs — Baja administrativa de una cuenta duplicada.
 *
 * `deleteAccount` (authController) exige la contraseña del propio usuario, así que
 * no sirve para una baja decidida por administración. Este script aplica EXACTAMENTE
 * los mismos efectos y respeta los MISMOS guards, más el asiento de auditoría que en
 * el endpoint pone el middleware.
 *
 * Corre en dos pasos: sin `--aplicar` solo muestra qué haría.
 *
 *   node scripts/baja-cuenta-duplicada.mjs <email> --conserva <email>
 *   node scripts/baja-cuenta-duplicada.mjs <email> --conserva <email> --aplicar
 */
import mongoose from 'mongoose';

const EMAIL    = process.argv[2];
const CONSERVA = process.argv[process.argv.indexOf('--conserva') + 1];
const APLICAR  = process.argv.includes('--aplicar');

if (!EMAIL || !CONSERVA || EMAIL.startsWith('--')) {
  console.error('Uso: node baja-cuenta-duplicada.mjs <email-a-dar-de-baja> --conserva <email> [--aplicar]');
  process.exit(2);
}

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const { default: User }       = await import('../src/models/User.js');
const { default: WalletBOB }  = await import('../src/models/WalletBOB.js');
const { default: WalletUSDC } = await import('../src/models/WalletUSDC.js');
const { default: Transaction } = await import('../src/models/Transaction.js');
const { recordAdminAction }   = await import('../src/services/adminAuditService.js');

const user      = await User.findOne({ email: EMAIL.toLowerCase() });
const conservar = await User.findOne({ email: CONSERVA.toLowerCase() }).lean();
if (!user)      { console.error(`✗ No existe ${EMAIL}`); process.exit(1); }
if (!conservar) { console.error(`✗ No existe la cuenta a conservar ${CONSERVA}`); process.exit(1); }

console.log(`\nCUENTA A DAR DE BAJA   ${user.email}  (${user._id})`);
console.log(`CUENTA QUE SE CONSERVA ${conservar.email}  (${conservar._id})\n`);

// ── Guards, los mismos que deleteAccount ─────────────────────────────────────
const fallos = [];
if (user.role === 'admin') fallos.push('es una cuenta de administrador');
if (user.deletionStatus === 'deletion_requested') fallos.push('ya está dada de baja');

const EPS = 1e-6;
const [wb, wu] = await Promise.all([
  WalletBOB.findOne({ userId: user._id }).lean(),
  WalletUSDC.findOne({ userId: user._id }).lean(),
]);
const bob  = wb ? (wb.balance ?? 0) + (wb.balanceReserved ?? 0) + (wb.balanceFrozen ?? 0) : 0;
const usdc = wu ? (wu.balance ?? 0) + (wu.balanceReserved ?? 0) + (wu.balanceFrozen ?? 0) : 0;
if (bob > EPS || usdc > EPS) fallos.push(`tiene saldo: Bs ${bob} / ${usdc} USDC`);

const TERMINAL = ['completed', 'failed', 'refunded', 'cancelled'];
const enCurso = await Transaction.countDocuments({
  userId: user._id, archivedAt: null, status: { $nin: TERMINAL },
});
if (enCurso > 0) fallos.push(`tiene ${enCurso} operaciones en curso`);

// Que la que se conserva esté sana: dar de baja la equivocada es irreversible de hecho.
if (conservar.deletionStatus && conservar.deletionStatus !== 'active') {
  fallos.push(`la cuenta a conservar NO está activa (${conservar.deletionStatus})`);
}

console.log('GUARDS');
console.log(`  saldo ................. Bs ${bob} · ${usdc} USDC`);
console.log(`  operaciones en curso .. ${enCurso}`);
console.log(`  rol ................... ${user.role ?? 'user'}`);
console.log(`  estado actual ......... ${user.deletionStatus ?? 'active'} / isActive=${user.isActive}`);
console.log(`  KYC ................... ${user.kycStatus}`);

if (fallos.length) {
  console.error(`\n✗ NO se aplica:\n   - ${fallos.join('\n   - ')}\n`);
  process.exit(1);
}
console.log('  ✓ todos los guards en verde');

const antes = {
  deletionStatus: user.deletionStatus ?? 'active',
  isActive:       user.isActive,
  tokenVersion:   user.tokenVersion ?? 0,
  alytoAlias:     user.alytoAlias ?? null,
  phone:          user.phone ?? null,
  fcmTokens:      (user.fcmTokens ?? []).length,
};

if (!APLICAR) {
  console.log('\n(ensayo: no se escribió nada. Añadir --aplicar)\n');
  await mongoose.disconnect();
  process.exit(0);
}

// ── Baja con retención de cumplimiento ───────────────────────────────────────
user.deletionStatus      = 'deletion_requested';
user.deletionRequestedAt = new Date();
user.isActive            = false;
user.tokenVersion        = (user.tokenVersion ?? 0) + 1;  // revoca todos los JWT
user.fcmTokens           = [];
user.alytoAlias          = null;
user.aliasUpdatedAt      = new Date();
user.phone               = undefined;
user.avatarUrl           = null;
if (user.preferences?.notifications) {
  user.preferences.notifications.email = false;
  user.preferences.notifications.push  = false;
}
await user.save();

const despues = {
  deletionStatus: user.deletionStatus,
  isActive:       user.isActive,
  tokenVersion:   user.tokenVersion,
  alytoAlias:     null,
  phone:          null,
  fcmTokens:      0,
};

// El actor es una persona real, no el script: la auditoría tiene que poder responder
// quién decidió, no sólo qué proceso escribió.
const actor = await User.findOne({ role: 'admin', email: process.env.ADMIN_ACTOR_EMAIL }).lean()
  ?? await User.findOne({ role: 'admin' }).sort({ createdAt: 1 }).lean();

await recordAdminAction({
  actor,
  action:     'user.deactivate.duplicate',
  targetType: 'user',
  targetId:   user._id,
  before:     antes,
  after:      despues,
  reason:     `Cuenta duplicada de la misma persona natural. Se conserva ${conservar.email}, que concentra la verificación vigente y el saldo.`,
  metadata:   {
    cuentaConservada:   String(conservar._id),
    emailConservado:    conservar.email,
    coincidePor:        ['documento', 'telefono', 'fechaNacimiento'],
    saldoAlDarDeBaja:   { bob, usdc },
    ejecutadoPor:       'scripts/baja-cuenta-duplicada.mjs',
  },
});

console.log('\n✓ Cuenta dada de baja. Antes → después:');
console.table([{ campo: 'deletionStatus', antes: antes.deletionStatus, despues: despues.deletionStatus },
               { campo: 'isActive',       antes: antes.isActive,       despues: despues.isActive },
               { campo: 'tokenVersion',   antes: antes.tokenVersion,   despues: despues.tokenVersion },
               { campo: 'alytoAlias',     antes: antes.alytoAlias,     despues: despues.alytoAlias },
               { campo: 'phone',          antes: antes.phone,          despues: despues.phone }]);
console.log(`  auditoría: actor ${actor?.email ?? '(ninguno)'} · acción user.deactivate.duplicate`);

// Relectura, para no reportar el objeto en memoria sino lo que quedó en la base.
const verificado = await db.collection('users').findOne(
  { _id: user._id },
  { projection: { email: 1, isActive: 1, deletionStatus: 1, deletionRequestedAt: 1, tokenVersion: 1, phone: 1, alytoAlias: 1, kycStatus: 1 } },
);
console.log('\nRELEÍDO DE LA BASE:');
console.log(JSON.stringify(verificado, null, 2));

await mongoose.disconnect();
