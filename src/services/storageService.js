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
 *   S3_OBJECT_LOCK_ENABLED — 'true' fija Object Lock COMPLIANCE POR OBJETO en
 *                            keys inmutables (pdfs/*) en cada PutObject (ASFI 5 años)
 *   S3_OBJECT_LOCK_DAYS    — días de retención (default 1825 = 5 años)
 *
 * Inmutabilidad (AWS-1D / ASFI): la retención NO se delega al default del bucket.
 * Cada PutObject de un comprobante/evidencia fija explícitamente
 * ObjectLockMode='COMPLIANCE' + ObjectLockRetainUntilDate=hoy+N días. Solo AWS S3
 * nativo lo soporta; sobre Cloudflare R2 el lock es imposible y se omite (ver guard).
 *
 * Funciones exportadas:
 *   uploadBuffer(buffer, key, opts?)  → { url, key, storage }
 *   getDownloadUrl(key, expiresIn?)   → string (presigned o pública)
 *   isS3Enabled()                     → boolean
 *   getObjectLockStatus(key)          → estado de retención por objeto (auditoría)
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createWriteStream, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import * as Sentry from '@sentry/node'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── AWS-1D: helpers de Object Lock COMPLIANCE (inmutabilidad ASFI 5 años) ─────
// Object Lock SOLO funciona en un bucket AWS S3 nativo creado con Object Lock.
// Cloudflare R2 NO lo soporta: si se activa contra R2, el PutObject con
// ObjectLockMode se ignora silenciosamente y la retención NO se aplica (falso
// cumplimiento). Provisionar bucket S3 con scripts/aws/setup-object-lock-bucket.sh.

// Retención ASFI Bolivia: 5 años = 1825 días (configurable vía S3_OBJECT_LOCK_DAYS).
const ASFI_RETENTION_DAYS = Number(process.env.S3_OBJECT_LOCK_DAYS) || 1825

// Prefijos de key cuyos objetos son evidencia regulatoria y DEBEN ser inmutables
// (comprobantes de operación retail, facturas B2B, evidencias). Todo lo demás
// (assets, temporales) no recibe retención.
const IMMUTABLE_KEY_PREFIXES = ['pdfs/']

function isR2Endpoint() {
  return /r2\.cloudflarestorage\.com/i.test(process.env.S3_ENDPOINT ?? '')
}

function objectLockEnabled() {
  return process.env.S3_OBJECT_LOCK_ENABLED === 'true'
}

function keyRequiresImmutability(key) {
  return IMMUTABLE_KEY_PREFIXES.some((p) => String(key ?? '').startsWith(p))
}

// Aviso temprano de configuración incoherente (flag ON contra R2 = falso cumplimiento).
if (objectLockEnabled() && isR2Endpoint()) {
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

/**
 * Parámetros de Object Lock por objeto para el PutObject.
 *
 * Fija EXPLÍCITAMENTE COMPLIANCE + retain-until = hoy + ASFI_RETENTION_DAYS en
 * CADA subida de un objeto inmutable — NO delega en el default del bucket
 * (requisito ASFI: inmutabilidad garantizada a nivel de aplicación).
 *
 * Devuelve {} (sin lock) cuando:
 *   - el flag S3_OBJECT_LOCK_ENABLED no es 'true' (reversibilidad), o
 *   - el key no es de un objeto inmutable (no empieza por un prefijo de pdfs/), o
 *   - el endpoint es Cloudflare R2 (que ignoraría el lock → falso cumplimiento).
 *
 * Nota IAM: enviar ObjectLockMode/ObjectLockRetainUntilDate en PutObject exige el
 * permiso s3:PutObjectRetention en la policy del usuario/rol de runtime.
 */
function _objectLockParams(key) {
  if (!objectLockEnabled() || !keyRequiresImmutability(key)) return {}
  if (isR2Endpoint()) return {}

  const retainUntil = new Date(Date.now() + ASFI_RETENTION_DAYS * 24 * 60 * 60 * 1000)
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

  // Si hay base URL pública (CDN) → URL directa. Si no → guardar referencia al key;
  // las URLs pre-firmadas se generan on-demand con getDownloadUrl() (máx 7 días SigV4).
  const baseUrl = process.env.S3_PDF_BASE_URL
  const url = baseUrl
    ? `${baseUrl.replace(/\/$/, '')}/${key}`
    : `s3key://${key}`

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

/**
 * Resuelve una referencia de comprobante almacenada en BD a una URL descargable.
 * Acepta:
 *   - 's3key://<key>'  → genera presigned URL fresca (1 hora)
 *   - URL http/https   → devuelve tal cual (URL pública o presigned ya generada)
 *   - null/undefined   → devuelve null
 *
 * @param {string|null} stored — valor de boliviaCompliance.comprobanteUrl en MongoDB
 * @returns {Promise<string|null>}
 */
export async function resolveComprobanteUrl(stored) {
  if (!stored) return null
  if (stored.startsWith('s3key://')) {
    const key = stored.slice('s3key://'.length)
    return getDownloadUrl(key, 3600) // URL fresca de 1 hora
  }
  return stored
}

// ─── Verificación de Object Lock (auditoría ASFI) ──────────────────────────────

/**
 * Consulta y devuelve el estado de Object Lock de un objeto ya almacenado.
 *
 * Sirve para demostrar ante un auditor que la retención COMPLIANCE está aplicada
 * POR OBJETO (no solo por default del bucket). Consume `s3key://<key>` o el key
 * pelado indistintamente.
 *
 * @param {string} storedOrKey — 's3key://pdfs/...' o 'pdfs/...'
 * @returns {Promise<{
 *   key: string, bucket: string|null, endpoint: string, isR2: boolean,
 *   lockFlagEnabled: boolean, supported: boolean,
 *   mode: 'COMPLIANCE'|'GOVERNANCE'|null, retainUntilDate: Date|null,
 *   note: string, error?: string
 * }>}
 */
export async function getObjectLockStatus(storedOrKey) {
  const key = String(storedOrKey ?? '').replace(/^s3key:\/\//, '')

  const base = {
    key,
    bucket:          process.env.S3_BUCKET ?? null,
    endpoint:        process.env.S3_ENDPOINT || 'aws-native',
    isR2:            isR2Endpoint(),
    lockFlagEnabled: objectLockEnabled(),
    mode:            null,
    retainUntilDate: null,
  }

  if (!isS3Enabled()) {
    return { ...base, supported: false, note: 'S3 no configurado (storage local) — sin inmutabilidad.' }
  }
  if (isR2Endpoint()) {
    return { ...base, supported: false, note: 'Endpoint Cloudflare R2 — Object Lock no soportado; retención NO aplicada ni verificable.' }
  }
  if (!key) {
    return { ...base, supported: true, note: 'Key vacío.' }
  }

  try {
    const res = await getS3Client().send(
      new GetObjectRetentionCommand({ Bucket: process.env.S3_BUCKET, Key: key })
    )
    const mode = res?.Retention?.Mode ?? null
    return {
      ...base,
      supported:       true,
      mode,
      retainUntilDate: res?.Retention?.RetainUntilDate ?? null,
      note: mode
        ? `Retención por objeto verificada (${mode}).`
        : 'Objeto sin retención por objeto — revisar configuración.',
    }
  } catch (err) {
    // NoSuchObjectLockConfiguration / ObjectLockConfigurationNotFoundError => bucket sin lock.
    Sentry.captureException(err, { tags: { service: 'storageService', fn: 'getObjectLockStatus' } })
    return {
      ...base,
      supported: true,
      error:     err?.name || err?.message,
      note:      'No se pudo leer la retención (¿falta permiso s3:GetObjectRetention, bucket sin Object Lock, u objeto inexistente?).',
    }
  }
}
