#!/usr/bin/env bash
#
# setup-lambda-jobs.sh — AWS-2A
# Crea la función Lambda alyto-job-trigger + 8 reglas EventBridge para
# disparar los jobs cron del backend vía el endpoint interno.
#
# Es IDEMPOTENTE: si la Lambda o las reglas ya existen, las actualiza.
#
# Requisitos:
#   - AWS CLI v2 configurado con permisos:
#       lambda:CreateFunction, lambda:UpdateFunction*, lambda:AddPermission,
#       lambda:GetFunction,
#       iam:CreateRole, iam:GetRole, iam:AttachRolePolicy,
#       events:PutRule, events:PutTargets
#   - INTERNAL_JOB_TOKEN ya configurado en el backend (ver Paso 1 del runbook).
#   - Backend accesible en BACKEND_URL.
#
# Uso:
#   REGION=us-east-1 \
#   BACKEND_URL=https://api.alyto.app \
#   INTERNAL_JOB_TOKEN=<token> \
#   bash scripts/aws/setup-lambda-jobs.sh
#
# Ver también: docs/AWS_LAMBDA_JOBS_RUNBOOK.md
#
set -euo pipefail

REGION="${REGION:-us-east-1}"
BACKEND_URL="${BACKEND_URL:-https://api.alyto.app}"
INTERNAL_JOB_TOKEN="${INTERNAL_JOB_TOKEN:-}"
FUNCTION_NAME="alyto-job-trigger"
ROLE_NAME="alyto-lambda-job-trigger-role"
LAMBDA_TIMEOUT=120  # segundos (jobs pesados deben responder antes)
LAMBDA_MEMORY=128   # MB — solo hace una llamada HTTP saliente
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAMBDA_SRC="${SCRIPT_DIR}/lambda/jobTrigger.mjs"

# ─── Validaciones ──────────────────────────────────────────────────────────────
if [ -z "${INTERNAL_JOB_TOKEN}" ]; then
  echo "❌  INTERNAL_JOB_TOKEN es requerido."
  echo "    Generar con:"
  echo "      node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  exit 1
fi

if [ ! -f "${LAMBDA_SRC}" ]; then
  echo "❌  No se encontró ${LAMBDA_SRC}"
  exit 1
fi

echo "==> Región:  ${REGION}"
echo "==> Backend: ${BACKEND_URL}"
echo "==> Función: ${FUNCTION_NAME}"
echo

# ─── Paso 1: IAM Role ─────────────────────────────────────────────────────────
echo "==> Paso 1: IAM Role ${ROLE_NAME}"

TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}'

ROLE_ARN=$(aws iam get-role \
  --role-name "${ROLE_NAME}" \
  --query 'Role.Arn' --output text 2>/dev/null || true)

if [ -z "${ROLE_ARN}" ]; then
  echo "    Creando role..."
  ROLE_ARN=$(aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "${TRUST_POLICY}" \
    --query 'Role.Arn' --output text)
  # Permiso básico de ejecución Lambda (CloudWatch Logs)
  aws iam attach-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "    Role creado. Esperando propagación IAM (10s)..."
  sleep 10
else
  echo "    Role ya existe."
fi
echo "    ARN: ${ROLE_ARN}"

# ─── Paso 2: Empaquetar función ────────────────────────────────────────────────
echo
echo "==> Paso 2: Empaquetar ${LAMBDA_SRC}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT  # limpieza garantizada al salir
cp "${LAMBDA_SRC}" "${TMP_DIR}/jobTrigger.mjs"
ZIP_PATH="${TMP_DIR}/jobTrigger.zip"
(cd "${TMP_DIR}" && zip -q "jobTrigger.zip" jobTrigger.mjs)
echo "    Zip listo: ${ZIP_PATH}"

# ─── Paso 3: Crear / actualizar función Lambda ─────────────────────────────────
echo
echo "==> Paso 3: Función Lambda ${FUNCTION_NAME}"

ENV_VARS="Variables={BACKEND_URL=${BACKEND_URL},INTERNAL_JOB_TOKEN=${INTERNAL_JOB_TOKEN}}"

EXISTING_FN=$(aws lambda get-function \
  --function-name "${FUNCTION_NAME}" \
  --region "${REGION}" 2>/dev/null || true)

if [ -z "${EXISTING_FN}" ]; then
  echo "    Creando función..."
  aws lambda create-function \
    --function-name "${FUNCTION_NAME}" \
    --runtime nodejs20.x \
    --role "${ROLE_ARN}" \
    --handler "jobTrigger.handler" \
    --zip-file "fileb://${ZIP_PATH}" \
    --timeout "${LAMBDA_TIMEOUT}" \
    --memory-size "${LAMBDA_MEMORY}" \
    --environment "${ENV_VARS}" \
    --region "${REGION}" \
    --output text --query 'FunctionArn' > /dev/null
  echo "    Función creada."
else
  echo "    Función ya existe — actualizando código y configuración..."
  aws lambda update-function-code \
    --function-name "${FUNCTION_NAME}" \
    --zip-file "fileb://${ZIP_PATH}" \
    --region "${REGION}" > /dev/null
  # Esperar a que update-function-code termine antes de cambiar configuración
  aws lambda wait function-updated \
    --function-name "${FUNCTION_NAME}" \
    --region "${REGION}" 2>/dev/null || sleep 5
  aws lambda update-function-configuration \
    --function-name "${FUNCTION_NAME}" \
    --timeout "${LAMBDA_TIMEOUT}" \
    --memory-size "${LAMBDA_MEMORY}" \
    --environment "${ENV_VARS}" \
    --region "${REGION}" > /dev/null
  echo "    Función actualizada."
fi

FUNCTION_ARN=$(aws lambda get-function \
  --function-name "${FUNCTION_NAME}" \
  --region "${REGION}" \
  --query 'Configuration.FunctionArn' --output text)
echo "    ARN: ${FUNCTION_ARN}"

# ─── Paso 4: EventBridge rules ─────────────────────────────────────────────────
echo
echo "==> Paso 4: Reglas EventBridge"
echo

# Formato: "nombre_regla|schedule|job_name"
RULES=(
  "alyto-cron-cleanup-orphans|rate(1 hour)|cleanup-orphans"
  "alyto-cron-kyc-monitor|rate(6 hours)|kyc-monitor"
  "alyto-cron-reconcile-harbor|rate(15 minutes)|reconcile-harbor"
  "alyto-cron-reconcile-vita|rate(15 minutes)|reconcile-vita"
  "alyto-cron-reconcile-stellar|rate(15 minutes)|reconcile-stellar"
  "alyto-cron-ros-monitor|rate(6 hours)|ros-monitor"
  "alyto-cron-ros-monitor-wallet|rate(6 hours)|ros-monitor-wallet"
  "alyto-cron-refresh-rates|rate(30 minutes)|refresh-rates"
)

for entry in "${RULES[@]}"; do
  IFS='|' read -r RULE_NAME SCHEDULE JOB_NAME <<< "${entry}"
  printf "    %-40s %s\n" "[${RULE_NAME}]" "→ ${SCHEDULE}"

  # Crear o actualizar la regla
  RULE_ARN=$(aws events put-rule \
    --name "${RULE_NAME}" \
    --schedule-expression "${SCHEDULE}" \
    --state ENABLED \
    --region "${REGION}" \
    --query 'RuleArn' --output text)

  # Permiso para que EventBridge invoque la Lambda
  # SID no puede tener guiones — los removemos
  SID="${RULE_NAME//-/}"
  aws lambda add-permission \
    --function-name "${FUNCTION_NAME}" \
    --statement-id "${SID}" \
    --action "lambda:InvokeFunction" \
    --principal "events.amazonaws.com" \
    --source-arn "${RULE_ARN}" \
    --region "${REGION}" > /dev/null 2>&1 || true  # ResourceConflictException si ya existe → OK

  # Input constante: {"job":"<nombre>"}
  # El campo Input en targets debe ser JSON-encoded string → escapado con \"
  TARGETS="[{\"Id\":\"1\",\"Arn\":\"${FUNCTION_ARN}\",\"Input\":\"{\\\"job\\\":\\\"${JOB_NAME}\\\"}\"}]"
  aws events put-targets \
    --rule "${RULE_NAME}" \
    --targets "${TARGETS}" \
    --region "${REGION}" > /dev/null
done

# ─── Resumen ───────────────────────────────────────────────────────────────────
echo
echo "✅  Setup Lambda completo."
echo
echo "    Lambda:  ${FUNCTION_ARN}"
echo "    Reglas:  ${#RULES[@]} reglas EventBridge creadas/actualizadas"
echo
echo "==> Próximos pasos:"
echo
echo "    1. PROBAR cada job en la consola Lambda:"
echo "       Lambda → ${FUNCTION_NAME} → Test → Event: {\"job\":\"refresh-rates\"}"
echo "       Esperado: {\"ok\":true, ...} y log de ejecución en CloudWatch del backend."
echo
echo "    2. VERIFICAR en el backend (requiere INTERNAL_JOB_TOKEN ya configurado):"
echo "       curl -s -X POST ${BACKEND_URL}/api/v1/internal/jobs/refresh-rates \\"
echo "         -H 'X-Internal-Token: \${INTERNAL_JOB_TOKEN}' | jq ."
echo
echo "    3. Cuando TODOS los jobs estén validados, ACTIVAR el scheduler externo:"
echo "       node --env-file=.env scripts/aws/update-secret-keys.mjs JOBS_EXTERNAL_SCHEDULER=true"
echo "       + agregar JOBS_EXTERNAL_SCHEDULER=true al .env del VPS y redeploy:"
echo "       cd ~/alyto-v2 && git pull && docker compose build && docker compose up -d --force-recreate alyto-backend"
echo
echo "    Ver: docs/AWS_LAMBDA_JOBS_RUNBOOK.md"
