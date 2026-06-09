#!/usr/bin/env bash
#
# update-secret-keys.sh — Actualiza claves en AWS Secrets Manager (alyto/production)
# sin necesidad de node_modules. Usa AWS CLI v2 + jq.
#
# Requisitos:
#   - AWS CLI v2  (aws --version)
#   - jq          (jq --version)
#   - Credenciales con secretsmanager:GetSecretValue + PutSecretValue sobre el secret.
#
# Uso:
#   bash scripts/aws/update-secret-keys.sh KEY=VALUE [KEY2=VALUE2 ...] [-KEY_A_BORRAR] [--dry-run]
#
# Ejemplos:
#   bash scripts/aws/update-secret-keys.sh INTERNAL_JOB_TOKEN=abc123
#   bash scripts/aws/update-secret-keys.sh JOBS_EXTERNAL_SCHEDULER=true
#   bash scripts/aws/update-secret-keys.sh S3_ENDPOINT= S3_OBJECT_LOCK_ENABLED=true
#   bash scripts/aws/update-secret-keys.sh -CLAVE_A_BORRAR
#   bash scripts/aws/update-secret-keys.sh KEY=valor --dry-run
#
# Notas:
#   - KEY= (valor vacío) escribe string vacío.
#   - -KEY  (prefijo guion, sin =) borra la clave del secret.
#   - --dry-run muestra el diff sin escribir.
#   - NUNCA imprime valores, solo nombres de claves.
#
set -euo pipefail

SECRET_NAME="${AWS_SECRETS_NAME:-alyto/production}"
REGION="${AWS_REGION:-us-east-1}"

# ─── Verificar dependencias ────────────────────────────────────────────────────
if ! command -v aws &>/dev/null; then
  echo "❌  AWS CLI no encontrado. Instalar: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  exit 1
fi
if ! command -v jq &>/dev/null; then
  echo "❌  jq no encontrado. Instalar: sudo apt-get install -y jq  (o brew install jq)"
  exit 1
fi

# ─── Parsear argumentos ────────────────────────────────────────────────────────
DRY_RUN=false
SET_KEYS=()   # "KEY=VALUE"
DEL_KEYS=()   # "KEY"

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=true ;;
    -*=*)      # -KEY=VALUE no es un formato soportado
      echo "❌  Formato inválido: '${arg}'. Para borrar usar '-CLAVE' (sin =)."
      exit 1
      ;;
    -*)        DEL_KEYS+=("${arg:1}") ;;   # -KEY → borrar KEY
    *=*)       SET_KEYS+=("${arg}") ;;     # KEY=VALUE
    *)
      echo "❌  Argumento inválido: '${arg}'. Usar KEY=VALUE o -KEY_A_BORRAR."
      exit 1
      ;;
  esac
done

if [ ${#SET_KEYS[@]} -eq 0 ] && [ ${#DEL_KEYS[@]} -eq 0 ]; then
  echo "Uso: bash scripts/aws/update-secret-keys.sh KEY=VALUE [KEY2=VALUE2] [-KEY_BORRAR] [--dry-run]"
  exit 1
fi

# ─── Obtener secret actual ─────────────────────────────────────────────────────
echo "[update-secret] Leyendo secret '${SECRET_NAME}' (${REGION})..."
CURRENT_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "${SECRET_NAME}" \
  --region "${REGION}" \
  --query SecretString \
  --output text)

TOTAL=$(echo "${CURRENT_JSON}" | jq 'keys | length')
echo "[update-secret] Secret tiene ${TOTAL} campos."

# ─── Construir JSON actualizado ────────────────────────────────────────────────
UPDATED_JSON="${CURRENT_JSON}"

WILL_ADD=()
WILL_CHANGE=()
for pair in "${SET_KEYS[@]}"; do
  KEY="${pair%%=*}"
  VALUE="${pair#*=}"
  EXISTS=$(echo "${UPDATED_JSON}" | jq --arg k "${KEY}" 'has($k)')
  if [ "${EXISTS}" = "true" ]; then
    WILL_CHANGE+=("${KEY}")
  else
    WILL_ADD+=("${KEY}")
  fi
  # Actualizar o agregar la clave (jq --arg trata el valor como string)
  UPDATED_JSON=$(echo "${UPDATED_JSON}" | jq --arg k "${KEY}" --arg v "${VALUE}" '.[$k] = $v')
done

WILL_DELETE=()
for KEY in "${DEL_KEYS[@]}"; do
  EXISTS=$(echo "${UPDATED_JSON}" | jq --arg k "${KEY}" 'has($k)')
  if [ "${EXISTS}" = "true" ]; then
    WILL_DELETE+=("${KEY}")
    UPDATED_JSON=$(echo "${UPDATED_JSON}" | jq --arg k "${KEY}" 'del(.[$k])')
  fi
done

# ─── Mostrar diff ──────────────────────────────────────────────────────────────
if [ ${#WILL_ADD[@]} -gt 0 ]; then
  echo "[update-secret] Agregar:  ${WILL_ADD[*]}"
else
  echo "[update-secret] Agregar:  (ninguno)"
fi
if [ ${#WILL_CHANGE[@]} -gt 0 ]; then
  echo "[update-secret] Cambiar:  ${WILL_CHANGE[*]}"
else
  echo "[update-secret] Cambiar:  (ninguno)"
fi
if [ ${#WILL_DELETE[@]} -gt 0 ]; then
  echo "[update-secret] Borrar:   ${WILL_DELETE[*]}"
else
  echo "[update-secret] Borrar:   (ninguno)"
fi

if [ "${DRY_RUN}" = "true" ]; then
  echo "[update-secret] --dry-run: no se escribió nada."
  exit 0
fi

# No hay cambios reales
if [ ${#WILL_ADD[@]} -eq 0 ] && [ ${#WILL_CHANGE[@]} -eq 0 ] && [ ${#WILL_DELETE[@]} -eq 0 ]; then
  echo "[update-secret] Sin cambios — secret no modificado."
  exit 0
fi

# ─── Escribir secret actualizado ──────────────────────────────────────────────
aws secretsmanager put-secret-value \
  --secret-id "${SECRET_NAME}" \
  --region "${REGION}" \
  --secret-string "${UPDATED_JSON}" \
  --output text --query VersionId > /dev/null

NEW_TOTAL=$(echo "${UPDATED_JSON}" | jq 'keys | length')
echo "[update-secret] ✅ Secret actualizado: ${NEW_TOTAL} campos totales."
echo "[update-secret] ⚠️  Reiniciar el backend para tomar los cambios:"
echo "    cd ~/alyto-v2 && docker compose build && docker compose up -d --force-recreate alyto-backend"
