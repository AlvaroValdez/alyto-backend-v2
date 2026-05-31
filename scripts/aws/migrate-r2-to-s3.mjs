// scripts/aws/migrate-r2-to-s3.mjs
//
// Copia los comprobantes/facturas PDF del bucket actual (Cloudflare R2) al nuevo
// bucket AWS S3 nativo con Object Lock. Necesario para que los PDFs históricos
// sigan siendo accesibles tras cambiar S3_BUCKET/S3_ENDPOINT a S3 nativo.
//
// - Idempotente: salta objetos que ya existen en el destino.
// - Solo copia bajo el prefijo `pdfs/` (comprobantes retail + b2b).
// - Al escribir en un bucket con Object Lock por defecto, la retención COMPLIANCE
//   se aplica automáticamente (clock desde la fecha de migración).
// - NO borra nada de R2 (origen intacto para auditoría).
//
// Requisitos:
//   ORIGEN (R2):  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET
//                 (por defecto toma S3_* del .env actual si apuntan a R2)
//   DESTINO (S3): DEST_S3_ACCESS_KEY_ID, DEST_S3_SECRET_ACCESS_KEY,
//                 DEST_S3_BUCKET, DEST_S3_REGION (creds AWS con s3:PutObject/GetObject/ListBucket)
//
// Uso:
//   node scripts/aws/migrate-r2-to-s3.mjs --dry-run     # solo lista qué copiaría
//   node scripts/aws/migrate-r2-to-s3.mjs               # copia de verdad

import 'dotenv/config';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

const DRY_RUN = process.argv.includes('--dry-run');
const PREFIX = process.env.MIGRATE_PREFIX || 'pdfs/';

// ── Origen R2 (cae a las S3_* del .env si no se definen R2_*) ──
const SRC = {
  region: process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT || process.env.S3_ENDPOINT,
  bucket: process.env.R2_BUCKET || process.env.S3_BUCKET,
  accessKeyId: process.env.R2_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY,
};

// ── Destino S3 nativo ──
const DEST = {
  region: process.env.DEST_S3_REGION || 'us-east-1',
  bucket: process.env.DEST_S3_BUCKET,
  accessKeyId: process.env.DEST_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.DEST_S3_SECRET_ACCESS_KEY,
};

function assert(cond, msg) { if (!cond) { console.error('❌ ' + msg); process.exit(1); } }
assert(SRC.endpoint && /r2\.cloudflarestorage\.com/i.test(SRC.endpoint), 'ORIGEN no parece R2 (R2_ENDPOINT/S3_ENDPOINT).');
assert(SRC.bucket && SRC.accessKeyId && SRC.secretAccessKey, 'Faltan credenciales/bucket de ORIGEN R2.');
assert(DEST.bucket && DEST.accessKeyId && DEST.secretAccessKey, 'Faltan credenciales/bucket de DESTINO S3 (DEST_S3_*).');

const srcS3 = new S3Client({
  region: SRC.region, endpoint: SRC.endpoint, forcePathStyle: true,
  credentials: { accessKeyId: SRC.accessKeyId, secretAccessKey: SRC.secretAccessKey },
});
const destS3 = new S3Client({
  region: DEST.region,
  credentials: { accessKeyId: DEST.accessKeyId, secretAccessKey: DEST.secretAccessKey },
});

async function existsInDest(key) {
  try { await destS3.send(new HeadObjectCommand({ Bucket: DEST.bucket, Key: key })); return true; }
  catch { return false; }
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

async function main() {
  console.log(`[migrate] ORIGEN R2 bucket=${SRC.bucket} prefix=${PREFIX}`);
  console.log(`[migrate] DESTINO S3 bucket=${DEST.bucket} region=${DEST.region}`);
  console.log(`[migrate] modo=${DRY_RUN ? 'DRY-RUN' : 'COPIA REAL'}`);

  let token, total = 0, copied = 0, skipped = 0, failed = 0;
  do {
    const list = await srcS3.send(new ListObjectsV2Command({
      Bucket: SRC.bucket, Prefix: PREFIX, ContinuationToken: token,
    }));
    for (const obj of list.Contents || []) {
      total++;
      const key = obj.Key;
      if (await existsInDest(key)) { skipped++; continue; }
      if (DRY_RUN) { console.log(`  [copiaría] ${key} (${obj.Size}B)`); copied++; continue; }
      try {
        const got = await srcS3.send(new GetObjectCommand({ Bucket: SRC.bucket, Key: key }));
        const body = await streamToBuffer(got.Body);
        await destS3.send(new PutObjectCommand({
          Bucket: DEST.bucket, Key: key, Body: body,
          ContentType: got.ContentType || 'application/pdf',
          ServerSideEncryption: 'AES256',
          // Object Lock COMPLIANCE se aplica por la retención por defecto del bucket.
        }));
        copied++;
        if (copied % 25 === 0) console.log(`  ...${copied} copiados`);
      } catch (e) {
        failed++;
        console.error(`  ❌ ${key}: ${e.name} ${e.message}`);
      }
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);

  console.log(`[migrate] Total=${total} | ${DRY_RUN ? 'a copiar' : 'copiados'}=${copied} | ya existían=${skipped} | fallidos=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('[migrate] ❌', err.name, '::', err.message); process.exit(1); });
