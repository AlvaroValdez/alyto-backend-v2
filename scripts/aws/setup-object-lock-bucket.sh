#!/usr/bin/env bash
#
# setup-object-lock-bucket.sh — AWS-1D
# Crea un bucket AWS S3 NATIVO con Object Lock (modo COMPLIANCE) para los
# comprobantes/facturas de Bolivia (AV Finance SRL), cumpliendo la retención
# inmutable de 5 años (1825 días) exigida por ASFI.
#
# ⚠️ Object Lock SOLO puede habilitarse al CREAR el bucket. No se puede activar
#    sobre un bucket existente ni sobre Cloudflare R2 (R2 no lo soporta).
#
# Requisitos: AWS CLI v2 autenticado con permisos de administración S3
#   (s3:CreateBucket, s3:PutBucketVersioning, s3:PutObjectLockConfiguration,
#    s3:PutBucketPolicy, s3:PutBucketEncryption, s3:GetBucketObjectLockConfiguration).
#   El usuario runtime `alyto-secrets-writer` NO los tiene → usar credenciales admin.
#
# Uso:
#   BUCKET=alyto-pdfs-compliance REGION=us-east-1 DAYS=1825 \
#     bash scripts/aws/setup-object-lock-bucket.sh
#
set -euo pipefail

BUCKET="${BUCKET:-alyto-pdfs-compliance}"
REGION="${REGION:-us-east-1}"
DAYS="${DAYS:-1825}"

command -v aws >/dev/null 2>&1 || { echo "❌ AWS CLI v2 no instalado."; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || { echo "❌ Sin credenciales AWS válidas (aws configure / env)."; exit 1; }

echo "==> Identidad AWS:"
aws sts get-caller-identity --output text --query '[Account,Arn]'
echo "==> Bucket: ${BUCKET} | Region: ${REGION} | Retención COMPLIANCE: ${DAYS} días (~$((DAYS / 365)) años)"
echo

# Idempotencia: si el bucket ya existe, NO se puede activar Object Lock retroactivamente.
if aws s3api head-bucket --bucket "${BUCKET}" 2>/dev/null; then
  echo "⚠️  El bucket '${BUCKET}' YA existe."
  if aws s3api get-object-lock-configuration --bucket "${BUCKET}" >/dev/null 2>&1; then
    echo "✅ Ya tiene Object Lock configurado. Mostrando config y saliendo (idempotente):"
    aws s3api get-object-lock-configuration --bucket "${BUCKET}"
    exit 0
  fi
  echo "❌ El bucket existe SIN Object Lock. No se puede activar retroactivamente."
  echo "   Crear un bucket NUEVO con otro nombre (BUCKET=...) y migrar objetos."
  exit 1
fi

# 1) Crear bucket con Object Lock habilitado (también habilita versioning).
#    us-east-1 NO admite LocationConstraint; el resto sí.
if [ "${REGION}" = "us-east-1" ]; then
  aws s3api create-bucket \
    --bucket "${BUCKET}" \
    --object-lock-enabled-for-bucket
else
  aws s3api create-bucket \
    --bucket "${BUCKET}" \
    --region "${REGION}" \
    --create-bucket-configuration "LocationConstraint=${REGION}" \
    --object-lock-enabled-for-bucket
fi

# 2) Asegurar versioning (requerido por Object Lock; idempotente).
aws s3api put-bucket-versioning \
  --bucket "${BUCKET}" \
  --versioning-configuration "Status=Enabled"

# 3) Retención por defecto COMPLIANCE.
#    El código (storageService.js) además fija ObjectLockRetainUntilDate por objeto,
#    pero el default protege ante objetos subidos por otras vías.
aws s3api put-object-lock-configuration \
  --bucket "${BUCKET}" \
  --object-lock-configuration "ObjectLockEnabled=Enabled,Rule={DefaultRetention={Mode=COMPLIANCE,Days=${DAYS}}}"

# 4) Bloquear acceso público (los comprobantes se sirven vía presigned URL).
aws s3api put-public-access-block \
  --bucket "${BUCKET}" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# 5) Cifrado en reposo (SSE-S3).
aws s3api put-bucket-encryption \
  --bucket "${BUCKET}" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# 6) Verificación post-creación — falla ruidosamente si Object Lock no quedó activo.
echo
echo "==> Verificando Object Lock..."
LOCK_MODE="$(aws s3api get-object-lock-configuration --bucket "${BUCKET}" \
  --query 'ObjectLockConfiguration.Rule.DefaultRetention.Mode' --output text 2>/dev/null || echo NONE)"
if [ "${LOCK_MODE}" != "COMPLIANCE" ]; then
  echo "❌ Verificación FALLÓ: Object Lock no quedó en COMPLIANCE (got: ${LOCK_MODE})."
  exit 1
fi
echo "✅ Object Lock COMPLIANCE confirmado (${DAYS} días)."

echo
echo "==> ✅ Bucket listo. Configurar en Secrets Manager (alyto/production) / .env:"
cat <<EOF

  S3_BUCKET=${BUCKET}
  S3_REGION=${REGION}
  S3_ENDPOINT=                       # VACÍO — usar S3 nativo, NO el endpoint de R2
  S3_OBJECT_LOCK_ENABLED=true
  S3_OBJECT_LOCK_DAYS=${DAYS}
  S3_PDF_BASE_URL=                   # opcional (CDN); si vacío se usa presigned URL

EOF
echo "    ⚠️ NO reutilizar el endpoint de Cloudflare R2: R2 ignora Object Lock."
echo "    ⚠️ El IAM principal del runtime necesita s3:PutObject + s3:GetObject sobre ${BUCKET}/*"
echo "       (con Object Lock COMPLIANCE, ni el root puede borrar antes del plazo)."
