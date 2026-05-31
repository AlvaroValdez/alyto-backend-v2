// scripts/aws/setup-object-lock-bucket.mjs
//
// AWS-1D — Crea un bucket AWS S3 NATIVO con Object Lock (COMPLIANCE) para los
// comprobantes ASFI (inmutables 1825 días). Versión Node (NO requiere aws CLI;
// usa @aws-sdk/client-s3 que ya está instalado en el proyecto).
//
// ⚠️ Object Lock SOLO se habilita al CREAR el bucket. No retroactivo. R2 no lo soporta.
//
// CREDENCIALES: necesita llaves AWS *admin* con permisos S3 (CreateBucket,
//   PutBucketVersioning, PutObjectLockConfiguration, PutPublicAccessBlock,
//   PutBucketEncryption, GetObjectLockConfiguration). Pásalas por env, NO en el código.
//
// USO (en tu terminal, con un archivo .env.admin gitignored que contenga las llaves):
//   node --env-file=.env.admin scripts/aws/setup-object-lock-bucket.mjs --dry-run
//   node --env-file=.env.admin scripts/aws/setup-object-lock-bucket.mjs
//
// .env.admin debe contener:
//   AWS_ACCESS_KEY_ID=AKIA...        (llaves ADMIN, no las runtime)
//   AWS_SECRET_ACCESS_KEY=...
//   OBJECT_LOCK_BUCKET=alyto-pdfs-compliance   (opcional, default abajo)
//   OBJECT_LOCK_REGION=us-east-1               (opcional)
//   OBJECT_LOCK_DAYS=1825                       (opcional)

import {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutObjectLockConfigurationCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';

const BUCKET = process.env.OBJECT_LOCK_BUCKET || 'alyto-pdfs-compliance';
const REGION = process.env.OBJECT_LOCK_REGION || 'us-east-1';
const DAYS = parseInt(process.env.OBJECT_LOCK_DAYS || '1825', 10);
const DRY_RUN = process.argv.includes('--dry-run');

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  fail('Faltan AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (admin). Usar node --env-file=.env.admin ...');
}

// Cliente S3 NATIVO (sin endpoint = AWS, NO R2).
const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

console.log(`\n=== AWS-1D Object Lock bucket ===`);
console.log(`  Bucket : ${BUCKET}`);
console.log(`  Region : ${REGION}`);
console.log(`  Retención COMPLIANCE: ${DAYS} días (~${Math.round(DAYS / 365)} años)`);
console.log(`  Modo   : ${DRY_RUN ? 'DRY-RUN (no escribe)' : 'CREAR'}\n`);

async function bucketExists() {
  try { await s3.send(new HeadBucketCommand({ Bucket: BUCKET })); return true; }
  catch { return false; }
}

async function main() {
  // Idempotencia.
  if (await bucketExists()) {
    console.log(`⚠️  El bucket '${BUCKET}' ya existe.`);
    try {
      const cfg = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: BUCKET }));
      const mode = cfg?.ObjectLockConfiguration?.Rule?.DefaultRetention?.Mode;
      if (mode === 'COMPLIANCE') {
        console.log('✅ Ya tiene Object Lock COMPLIANCE. Nada que hacer (idempotente).');
        return;
      }
      fail('El bucket existe SIN Object Lock COMPLIANCE. No se puede activar retroactivamente. Usar otro nombre.');
    } catch {
      fail('El bucket existe pero no se pudo leer su Object Lock config (¿sin permiso o sin lock?).');
    }
  }

  if (DRY_RUN) {
    console.log('[DRY-RUN] Crearía el bucket con Object Lock + versioning + retención COMPLIANCE');
    console.log('[DRY-RUN] + block public access + cifrado AES256. No se escribió nada.');
    return;
  }

  // 1) Crear bucket con Object Lock (habilita versioning automáticamente).
  const createParams = { Bucket: BUCKET, ObjectLockEnabledForBucket: true };
  if (REGION !== 'us-east-1') {
    createParams.CreateBucketConfiguration = { LocationConstraint: REGION };
  }
  await s3.send(new CreateBucketCommand(createParams));
  console.log('  ✓ Bucket creado');

  // 2) Versioning explícito (idempotente).
  await s3.send(new PutBucketVersioningCommand({
    Bucket: BUCKET, VersioningConfiguration: { Status: 'Enabled' },
  }));
  console.log('  ✓ Versioning habilitado');

  // 3) Retención por defecto COMPLIANCE.
  await s3.send(new PutObjectLockConfigurationCommand({
    Bucket: BUCKET,
    ObjectLockConfiguration: {
      ObjectLockEnabled: 'Enabled',
      Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: DAYS } },
    },
  }));
  console.log('  ✓ Object Lock COMPLIANCE configurado');

  // 4) Bloquear acceso público (se sirve vía presigned URL).
  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: BUCKET,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, IgnorePublicAcls: true,
      BlockPublicPolicy: true, RestrictPublicBuckets: true,
    },
  }));
  console.log('  ✓ Acceso público bloqueado');

  // 5) Cifrado en reposo SSE-S3.
  await s3.send(new PutBucketEncryptionCommand({
    Bucket: BUCKET,
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
    },
  }));
  console.log('  ✓ Cifrado AES256 habilitado');

  // 6) Verificación.
  const cfg = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: BUCKET }));
  const mode = cfg?.ObjectLockConfiguration?.Rule?.DefaultRetention?.Mode;
  if (mode !== 'COMPLIANCE') fail(`Verificación falló: Object Lock quedó en '${mode}', no COMPLIANCE.`);
  console.log(`\n✅ Bucket listo y verificado: Object Lock COMPLIANCE (${DAYS} días).`);

  console.log(`\n=== Próximo: apuntar la config a este bucket (Paso 4 del runbook) ===`);
  console.log(`  S3_BUCKET=${BUCKET}`);
  console.log(`  S3_REGION=${REGION}`);
  console.log(`  S3_ENDPOINT=            (VACÍO — S3 nativo, NO R2)`);
  console.log(`  S3_OBJECT_LOCK_ENABLED=true`);
  console.log(`  S3_OBJECT_LOCK_DAYS=${DAYS}`);
}

main().catch((err) => fail(`${err.name}: ${err.message}`));
