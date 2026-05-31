/**
 * storageService.js — Almacenamiento de archivos (PDFs, comprobantes)
 *
 * Abstracción sobre S3 / S3-compatible (Cloudflare R2, MinIO).
 * Si S3 no está configurado → guarda en sistema de archivos local
 * (válido para desarrollo; en producción siempre configurar S3).
 *
 * Variables de entorno requeridas para S3:
 *   S3_BUCKET            — nombre del bucket
 *   S3_REGION            — región (ej: us-east-1)
 *   S3_ACCESS_KEY_ID     — credencial de acceso
 *   S3_SECRET_ACCESS_KEY — credencial secreta
 *   S3_ENDPOINT          — opcional: endpoint S3-compatible (R2, MinIO)
 *   S3_PDF_BASE_URL      — opcional: CDN base URL para URLs públicas
 *   S3_OBJECT_LOCK_ENABLED — 'true' activa Object Lock COMPLIANCE en pdfs/* (ASFI 5 años)
 *
 * Funciones exportadas:
 *   uploadBuffer(buffer, key, opts?)  → { url, key, storage }
 *   getDownloadUrl(key, expiresIn?)   → string (presigned o pública)
 *   isS3Enabled()                     → boolean
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createWriteStream, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import * as Sentry from '@sentry/node'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── AWS-1D: aviso de Object Lock incompatible con R2 ──────────────────────────
// Object Lock (inmutabilidad ASFI 5 años) SOLO funciona en un bucket AWS S3
// nativo creado con Object Lock. Cloudflare R2 NO lo soporta: si se activa
// contra R2, el PutObject con ObjectLockMode se ignora silenciosamente y la
// retención NO se aplica (falso cumplimiento). Provisionar bucket S3 con
// scripts/aws/setup-object-lock-bucket.sh.
if (
  process.env.S3_OBJECT_LOCK_ENABLED === 'true' &&
  /r2\.cloudflarestorage\.com/i.test(process.env.S3_ENDPOINT ?? '')
) {
  console.warn(
    '[Storage] ⚠️  S3_OBJECT_LOCK_ENABLED=true pero S3_ENDPOINT apunta a Cloudflare R2, ' +
    'que NO soporta Object Lock. La retención ASFI (5 años) NO se está aplicando. ' +
    'Usar un bucket AWS S3 nativo (scripts/aws/setup-object-lock-bucket.sh).'
  )
}

// ─── Cliente S3 (lazy init) ───────────────────────────────────────────────────

let _s3 = null

function getS3Client() {
  if (_s3) return _s3

  const region    = process.env.S3_REGION ?? 'us-east-1'
  const endpoint  = process.env.S3_ENDPOINT   // undefined = AWS nativo
  const accessKey = process.env.S3_ACCESS_KEY_ID
  const secretKey = process.env.S3_SECRET_ACCESS_KEY

  _s3 = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    credentials: accessKey && secretKey
      ? { accessKeyId: accessKey, secretAccessKey: secretKey }
      : undefined,
  })
  return _s3
}

export function isS3Enabled() {
  return !!(
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY
  )
}

// ─── Upload ───────────────────────────────────────────────────────────────────

/**
 * Sube un buffer al storage configurado.
 *
 * @param {Buffer}  buffer      — contenido del archivo
 * @param {string}  key         — ruta dentro del bucket (ej: 'pdfs/BOL-202605-000001.pdf')
 * @param {object}  [opts]
 * @param {string}  [opts.contentType='application/pdf']
 * @param {string}  [opts.disposition]  — Content-Disposition override
 * @returns {Promise<{ url: string, key: string, storage: 'S3'|'local' }>}
 */
export async function uploadBuffer(buffer, key, opts = {}) {
  const contentType = opts.contentType ?? 'application/pdf'

  if (isS3Enabled()) {
    return _uploadToS3(buffer, key, contentType, opts.disposition)
  }

  return _saveLocal(buffer, key)
}

// Retención ASFI Bolivia: 5 años = 1825 días
const ASFI_RETENTION_DAYS = 1825

function _objectLockParams(key) {
  if (process.env.S3_OBJECT_LOCK_ENABLED !== 'true') return {}
  if (!key.startsWith('pdfs/')) return {}
  const retainUntil = new Date()
  retainUntil.setDate(retainUntil.getDate() + ASFI_RETENTION_DAYS)
  return {
    ObjectLockMode:            'COMPLIANCE',
    ObjectLockRetainUntilDate: retainUntil,
  }
}

async function _uploadToS3(buffer, key, contentType, disposition) {
  const bucket = process.env.S3_BUCKET

  const cmd = new PutObjectCommand({
    Bucket:             bucket,
    Key:                key,
    Body:               buffer,
    ContentType:        contentType,
    ContentDisposition: disposition ?? `attachment; filename="${key.split('/').pop()}"`,
    ServerSideEncryption: 'AES256',
    Metadata: {
      'uploaded-by': 'alyto-backend',
      'uploaded-at': new Date().toISOString(),
    },
    ..._objectLockParams(key),
  })

  await getS3Client().send(cmd)

  // URL pública si el bucket lo permite, o pre-firmada si no
  const baseUrl = process.env.S3_PDF_BASE_URL
  const url = baseUrl
    ? `${baseUrl.replace(/\/$/, '')}/${key}`
    : await _presign(key, 365 * 24 * 3600) // URL larga (1 año) para persistencia en BD

  return { url, key, storage: 'S3' }
}

function _saveLocal(buffer, key) {
  const localBase = join(__dirname, '../../tmp/storage')
  const localPath = join(localBase, key)
  const localDir  = dirname(localPath)

  try {
    mkdirSync(localDir, { recursive: true })
    const ws = createWriteStream(localPath)
    ws.write(buffer)
    ws.end()
  } catch (err) {
    // No crítico — el buffer ya está en memoria para servir la respuesta
    console.warn('[Storage] No se pudo guardar localmente:', err.message)
  }

  console.warn('[Storage] ⚠️  S3 no configurado — archivo guardado en local:', localPath)
  return Promise.resolve({ url: `local://${key}`, key, storage: 'local' })
}

// ─── Download URL ─────────────────────────────────────────────────────────────

/**
 * Genera una URL de descarga para un key en S3.
 * Si S3 no está configurado, devuelve null.
 *
 * @param {string} key
 * @param {number} [expiresIn=3600]  — segundos de validez de la URL pre-firmada
 * @returns {Promise<string|null>}
 */
export async function getDownloadUrl(key, expiresIn = 3600) {
  if (!isS3Enabled() || !key || key.startsWith('local://')) return null

  const baseUrl = process.env.S3_PDF_BASE_URL
  if (baseUrl) return `${baseUrl.replace(/\/$/, '')}/${key}`

  try {
    return await _presign(key, expiresIn)
  } catch (err) {
    Sentry.captureException(err, { tags: { service: 'storageService', fn: 'getDownloadUrl' } })
    console.error('[Storage] Error generando presigned URL:', err.message)
    return null
  }
}

async function _presign(key, expiresIn) {
  const cmd = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key })
  return getSignedUrl(getS3Client(), cmd, { expiresIn })
}
