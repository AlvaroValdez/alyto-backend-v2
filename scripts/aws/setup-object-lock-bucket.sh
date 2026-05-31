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
#    s3:PutBucketPolicy). El usuario runtime `alyto-secrets-writer` NO los tiene.
#
# Uso:
#   BUCKET=alyto-pdfs-compliance REGION=us-east-1 DAYS=1825 \
#     bash scripts/aws/setup-object-lock-bucket.sh
#
set -euo pipefail

BUCKET="${BUCKET:-alyto-pdfs-compliance}"
REGION="${REGION:-us-east-1}"
DAYS="${DAYS:-1825}"

echo "==> Creando bucket S3 nativo con Object Lock"
echo "    Bucket: ${BUCKET}"
echo "    Region: ${REGION}"
echo "    Retención COMPLIANCE: ${DAYS} días (~$((DAYS / 365)) años)"
echo

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

# 2) Asegurar versioning (requerido por Object Lock; create-bucket ya lo activa,
#    pero lo dejamos explícito e idempotente).
aws s3api put-bucket-versioning \
  --bucket "${BUCKET}" \
  --versioning-configuration "Status=Enabled"

# 3) Configuración de retención por defecto COMPLIANCE.
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
