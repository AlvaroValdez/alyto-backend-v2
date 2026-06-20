/**
 * unstick-kyc-user.mjs — Desatasca a un usuario que quedó en 'in_review' por una
 * sesión biométrica de Stripe Identity abandonada/recuperable (no completó la
 * verificación). Lo devuelve a 'pending' para que pueda reintentar.
 *
 * Solo actúa si el usuario está en 'in_review' (no toca approved/rejected).
 *
 * Uso (dentro del container, con MONGODB_URI en el entorno):
 *   node scripts/unstick-kyc-user.mjs huascar7777777777@gmail.com
 */
import mongoose from 'mongoose';

const email = (process.argv[2] || '').toLowerCase().trim();
if (!email) {
  console.error('Uso: node scripts/unstick-kyc-user.mjs <email>');
  process.exit(1);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI no está definido en el entorno.');
  process.exit(1);
}

await mongoose.connect(uri);
const users = mongoose.connection.collection('users');

const before = await users.findOne(
  { email },
  { projection: { email: 1, kycStatus: 1, stripeVerificationSessionId: 1, emailVerified: 1, kycProfileCompletedAt: 1 } },
);

if (!before) {
  console.error(`Usuario no encontrado: ${email}`);
  await mongoose.disconnect();
  process.exit(1);
}

console.log('Antes:', JSON.stringify(before, null, 2));

if (before.kycStatus !== 'in_review') {
  console.log(`No se modifica — kycStatus actual es '${before.kycStatus}' (solo se desatasca 'in_review').`);
  await mongoose.disconnect();
  process.exit(0);
}

const r = await users.updateOne({ _id: before._id }, { $set: { kycStatus: 'pending' } });
console.log(`Actualizado: matched=${r.matchedCount} modified=${r.modifiedCount} → kycStatus='pending'`);
console.log('El usuario ya puede reintentar la verificación desde la app.');

await mongoose.disconnect();
process.exit(0);
