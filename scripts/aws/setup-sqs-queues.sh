#!/usr/bin/env bash
#
# setup-sqs-queues.sh — AWS-2B
# Crea las colas SQS de buffer de webhooks (IPN) + una Dead-Letter Queue común
# con redrive policy (maxReceiveCount=3).
#
# Colas: alyto-ipn-vita, alyto-ipn-fintoc, alyto-ipn-owlpay, alyto-ipn-stripe
# DLQ:   alyto-ipn-dlq
#
# Requisitos: AWS CLI v2 con permisos sqs:CreateQueue, sqs:GetQueueAttributes,
#   sqs:SetQueueAttributes. El runtime necesitará además sqs:SendMessage,
#   sqs:ReceiveMessage, sqs:DeleteMessage sobre estas colas.
#
# Uso:
#   REGION=us-east-1 bash scripts/aws/setup-sqs-queues.sh
#
set -euo pipefail

REGION="${REGION:-us-east-1}"
DLQ_NAME="alyto-ipn-dlq"
QUEUES=("alyto-ipn-vita" "alyto-ipn-fintoc" "alyto-ipn-owlpay" "alyto-ipn-stripe")
MAX_RECEIVE="${MAX_RECEIVE:-3}"

echo "==> Region: ${REGION}"

create_queue() {
  # $1 = nombre; $2 = attributes JSON (opcional)
  local name="$1"
  local attrs="${2:-}"
  if [ -n "${attrs}" ]; then
    aws sqs create-queue --queue-name "${name}" --region "${REGION}" --attributes "${attrs}" >/dev/null
  else
    aws sqs create-queue --queue-name "${name}" --region "${REGION}" >/dev/null
  fi
  aws sqs get-queue-url --queue-name "${name}" --region "${REGION}" --output text --query QueueUrl
}

queue_arn() {
  local url="$1"
  aws sqs get-queue-attributes --queue-url "${url}" --region "${REGION}" \
    --attribute-names QueueArn --output text --query 'Attributes.QueueArn'
}

echo "==> Creando DLQ: ${DLQ_NAME}"
DLQ_URL="$(create_queue "${DLQ_NAME}" 'MessageRetentionPeriod=1209600')" # 14 días
DLQ_ARN="$(queue_arn "${DLQ_URL}")"
echo "    DLQ ARN: ${DLQ_ARN}"

REDRIVE="{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"${MAX_RECEIVE}\"}"
# El JSON de redrive debe ir escapado dentro del map de attributes.
REDRIVE_ESCAPED="$(printf '%s' "${REDRIVE}" | sed 's/"/\\"/g')"

echo
echo "==> Configurar en Secrets Manager (alyto/production) / .env:"
echo
echo "  SQS_ENABLED=true"
echo "  AWS_REGION=${REGION}"

for q in "${QUEUES[@]}"; do
  echo "==> Creando cola: ${q}" >&2
  ATTRS="VisibilityTimeout=60,MessageRetentionPeriod=345600,RedrivePolicy=\"${REDRIVE_ESCAPED}\""
  URL="$(create_queue "${q}" "${ATTRS}")"
  # Derivar la env var: alyto-ipn-vita → SQS_QUEUE_URL_VITA
  SUFFIX="$(printf '%s' "${q}" | sed 's/alyto-ipn-//' | tr '[:lower:]' '[:upper:]')"
  echo "  SQS_QUEUE_URL_${SUFFIX}=${URL}"
done

echo
echo "    ⚠️ El IAM principal del runtime necesita sobre estas colas + DLQ:"
echo "       sqs:SendMessage, sqs:ReceiveMessage, sqs:DeleteMessage, sqs:GetQueueAttributes"
echo "    ⚠️ Activar SQS_ENABLED=true SOLO tras verificar el consumer en staging."
