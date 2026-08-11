/**
 * migrate-encrypt-identity-numbers.mjs — Cifra los CI existentes en claro.
 *
 * Recorre los usuarios cuyo `identityDocument.number` es un CI REAL en texto plano
 * y aún NO tiene `identityDocument.numberCiphertext`, y los migra al modelo cifrado:
 *   number → marcador 'ENCRYPTED'  +  numberCiphertext → 'v1:...' (AES-256-GCM/DEK KMS)
 *
 * Idempotente: salta los que ya están cifrados o son placeholders. Correrlo dos
 * veces no re-cifra ni corrompe nada.
 *
 * Requisitos: la DEK debe poder resolverse (PII_DATA_KEY_WRAPPED + KMS, o el
 * fallback de staging). Orden recomendado: provisionar DEK → PII_ENCRYPTION_ENABLED=true
 * → redeploy → correr esta migración (primero staging, luego prod).
 *
 * Uso (dentro del container, para heredar KMS/Mongo del entorno):
 *   # 1) Dry-run (default) — lista a quién migraría, con el CI enmascarado:
 *   docker compose exec alyto-backend node scripts/migrate-encrypt-identity-numbers.mjs
 *
 *   # 2) Ejecución real:
 *   docker compose exec -e MIGRATE_CONFIRM=true alyto-backend \
 *     node scripts/migrate-encrypt-identity-numbers.mjs
 */

import 'dotenv/config';
import { loadSecretsIntoEnv } from '../src/utils/awsSecrets.js';

await loadSecretsIntoEnv();

const { default: mongoose } = await import('mongoose');
const { default: User }     = await import('../src/models/User.js');
const { ensureDek, encryptField, aadForDocumentNumber, PII_ENCRYPTED_MARKER } =
  await import('../src/services/piiCrypto.js');
const { isRealDocumentNumber } = await import('../src/utils/clientDocument.js');

const CONFIRM = process.env.MIGRATE_CONFIRM === 'true';

function mask(v) {
  if (typeof v !== 'string' || v.length <= 3) return '***';
  return `${v.slice(0, 2)}***${v.slice(-1)}`;
}

// Asegurar la DEK ANTES de tocar la BD (falla temprano si no está configurada).
await ensureDek();

await mongoose.connect(process.env.MONGODB_URI);

// Candidatos: tienen un number no vacío/no-sentinel/no-marcador y sin ciphertext.
const candidates = await User.find({
  'identityDocument.number': { $exists: true, $nin: [null, '', 'PENDING_VERIFICATION', PII_ENCRYPTED_MARKER] },
  $or: [
    { 'identityDocument.numberCiphertext': { $exists: false } },
    { 'identityDocument.numberCiphertext': null },
  ],
})
  .select('_id email identityDocument.number +identityDocument.numberCiphertext')
  .lean();

console.log(`[migrate-pii] ${candidates.length} candidato(s)${CONFIRM ? '' : '  (DRY RUN — no se escribe nada; usar MIGRATE_CONFIRM=true para ejecutar)'}`);

let migrated = 0, skipped = 0, failed = 0;

for (const u of candidates) {
  const raw = u.identityDocument?.number;

  // Doble chequeo de idempotencia + placeholders (el filtro de Mongo ya excluye,
  // pero isRealDocumentNumber cubre variantes tipo 'En verificación').
  if (u.identityDocument?.numberCiphertext || !isRealDocumentNumber(raw)) {
    skipped++;
    continue;
  }

  if (!CONFIRM) {
    console.log(`  [dry] ${u._id} | ${u.email} | CI=${mask(raw)}`);
    continue;
  }

  try {
    const ciphertext = encryptField(raw, aadForDocumentNumber(u._id));
    await User.updateOne(
      { _id: u._id, 'identityDocument.numberCiphertext': { $in: [null, undefined] } }, // guard anti-carrera
      { $set: {
        'identityDocument.number':           PII_ENCRYPTED_MARKER,
        'identityDocument.numberCiphertext': ciphertext,
      } },
    );
    migrated++;
    console.log(`  [ok]  ${u._id} | ${u.email} | CI=${mask(raw)} → cifrado`);
  } catch (err) {
    failed++;
    console.error(`  [err] ${u._id} | ${u.email}: ${err.message}`);
  }
}

console.log(`\n[migrate-pii] Resumen — migrados: ${migrated} | saltados: ${skipped} | fallidos: ${failed}${CONFIRM ? '' : '  (DRY RUN)'}`);

await mongoose.disconnect();
process.exit(failed > 0 ? 1 : 0);
