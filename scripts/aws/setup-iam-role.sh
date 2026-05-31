#!/usr/bin/env bash
#
# setup-iam-role.sh — AWS-1C
# Crea un IAM Role de runtime con política de MÍNIMO PRIVILEGIO para que el
# backend acceda a Secrets Manager, CloudWatch Logs, S3 (comprobantes) y SQS
# (buffer IPN) SIN access keys estáticas en el .env.
#
# ⚠️ Adjuntar un Role al cómputo solo es posible en EC2/ECS/EKS (instance
#    profile / task role). Si el backend corre en un VPS genérico NO-AWS, no
#    hay instance role: mantener un IAM USER de mínimo privilegio con esta
#    misma política y access keys rotadas (ver --create-user abajo).
#
# Requisitos: AWS CLI v2 con permisos iam:CreateRole/CreatePolicy/AttachRolePolicy
#   /CreateInstanceProfile (admin IAM).
#
# Uso (EC2 instance profile):
#   ACCOUNT_ID=233927217454 BUCKET=alyto-pdfs-compliance REGION=us-east-1 \
#     bash scripts/aws/setup-iam-role.sh
#
set -euo pipefail

ACCOUNT_ID="${ACCOUNT_ID:?Definir ACCOUNT_ID}"
REGION="${REGION:-us-east-1}"
BUCKET="${BUCKET:-alyto-pdfs-compliance}"
ROLE_NAME="${ROLE_NAME:-alyto-backend-runtime}"
POLICY_NAME="${POLICY_NAME:-alyto-runtime-leastprivilege}"

# Política de mínimo privilegio (los 4 servicios del runtime).
POLICY_DOC=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SecretsRead",
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:alyto/production*"
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams"
      ],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/alyto/backend:*"
    },
    {
      "Sid": "S3Comprobantes",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "SqsIpnBuffer",
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:${REGION}:${ACCOUNT_ID}:alyto-ipn-*"
    }
  ]
}
JSON
)

TRUST_DOC=$(cat <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON
)

echo "==> Creando policy ${POLICY_NAME}"
POLICY_ARN=$(aws iam create-policy \
  --policy-name "${POLICY_NAME}" \
  --policy-document "${POLICY_DOC}" \
  --query 'Policy.Arn' --output text 2>/dev/null || \
  echo "arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}")
echo "    Policy ARN: ${POLICY_ARN}"

if [ "${1:-}" = "--create-user" ]; then
  # Fallback VPS genérico: IAM user (no role)
  USER_NAME="${USER_NAME:-alyto-backend-runtime-user}"
  echo "==> Creando IAM user ${USER_NAME} (fallback VPS no-AWS)"
  aws iam create-user --user-name "${USER_NAME}" >/dev/null 2>&1 || true
  aws iam attach-user-policy --user-name "${USER_NAME}" --policy-arn "${POLICY_ARN}"
  echo "    Generar access keys: aws iam create-access-key --user-name ${USER_NAME}"
  echo "    ⚠️ Rotar periódicamente. Esta es la opción degradada (sin Role)."
  exit 0
fi

echo "==> Creando role ${ROLE_NAME} (EC2 instance profile)"
aws iam create-role \
  --role-name "${ROLE_NAME}" \
  --assume-role-policy-document "${TRUST_DOC}" >/dev/null 2>&1 || true
aws iam attach-role-policy --role-name "${ROLE_NAME}" --policy-arn "${POLICY_ARN}"

aws iam create-instance-profile --instance-profile-name "${ROLE_NAME}" >/dev/null 2>&1 || true
aws iam add-role-to-instance-profile \
  --instance-profile-name "${ROLE_NAME}" --role-name "${ROLE_NAME}" 2>/dev/null || true

echo
echo "==> ✅ Role listo. Pasos finales:"
echo "  1) Asociar el instance profile '${ROLE_NAME}' a la instancia EC2/ECS."
echo "  2) ELIMINAR AWS_ACCESS_KEY_ID y AWS_SECRET_ACCESS_KEY del .env / Secrets Manager."
echo "  3) Reiniciar el backend y verificar en logs: '[awsSecrets] Modo de credenciales AWS: default-chain'."
