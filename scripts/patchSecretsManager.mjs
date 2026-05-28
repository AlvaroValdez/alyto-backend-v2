/**
 * patchSecretsManager.mjs — Agrega variables faltantes al secret existente
 *
 * NO reemplaza el secret completo — hace merge con lo que ya existe.
 * Ejecutar una sola vez, luego eliminar este archivo.
 *
 * USO en VPS:
 *   AWS_KEY=$(aws configure get aws_access_key_id)
 *   AWS_SECRET=$(aws configure get aws_secret_access_key)
 *   docker compose exec \
 *     -e AWS_ACCESS_KEY_ID=$AWS_KEY \
 *     -e AWS_SECRET_ACCESS_KEY=$AWS_SECRET \
 *     -e AWS_REGION=us-east-1 \
 *     alyto-backend node scripts/patchSecretsManager.mjs
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const SECRET_ID = process.env.AWS_SECRETS_NAME ?? 'alyto/production';
const REGION    = process.env.AWS_REGION       ?? 'us-east-1';

// ─── Variables a agregar / actualizar ────────────────────────────────────────

const PATCH = {
  // ── SendGrid templates nuevos ──
  SENDGRID_TEMPLATE_WELCOME:               'd-dbf09b708b7149d4886bd4d65298390d',
  SENDGRID_TEMPLATE_MANUAL_PAYIN:          'd-5ba04ea104f54f41b2c968469dfbd459',
  SENDGRID_TEMPLATE_ADMIN_MANUAL_PAYIN:    'd-795680ffe40d4a62ac86d8eb39b47e95',
  SENDGRID_TEMPLATE_DEPOSIT_CONFIRMED:     'd-71dddbbc71c14f3c8900547b27f67e48',
  SENDGRID_TEMPLATE_REQUOTE_NOTIFICATION:  'd-867fd3df4e074840aed2a0248a1c27bc',

  // ── Bolivia SRL — datos operativos ──
  SRL_ACCOUNT_NUMBER:   '1311020168',
  AV_FINANCE_NIT:       '706138025',
  AV_FINANCE_ADDRESS:   'Calle Otero de la Vega N° 295, San Pedro, La Paz',

  // ── Pie de página legal retail (comprobantes Bolivia) ──
  AV_FINANCE_LEGAL_FOOTER: [
    'AV FINANCE S.R.L. | Tecnología Financiera',
    'Sede Administrativa: Av. Ramiro Castillo N° 13, Kalajahuira, La Paz.',
    'Sede Operativa: Calle Otero de la Vega N° 295, San Pedro, La Paz.',
    '',
    'Aviso Legal: AV FINANCE S.R.L. es una entidad supervisada por la ASFI bajo la licencia',
    'de Empresa de Tecnología Financiera (ETF). La presente comunicación es confidencial',
    'y su uso no autorizado está prohibido. El manejo de sus datos personales y operaciones',
    'se rige bajo nuestras Políticas de Privacidad y la normativa de la UIF sobre prevención',
    'de legitimación de ganancias ilícitas. Para cualquier reclamo o consulta sobre nuestros',
    'servicios, comúníquese con nuestra Oficina de Atención al Cliente.',
  ].join('\n'),

  // ── Pie de página legal B2B (facturas empresariales) ──
  AV_FINANCE_B2B_LEGAL_FOOTER: [
    'AV FINANCE S.R.L. | Empresa de Tecnología Financiera (ETF)',
    '',
    'NIT: 706138025 | Matrícula de Comercio: [Completar con número SEPREC]',
    '',
    'Domicilio Legal: Av. Ramiro Castillo N° 13, Kalajahuira, La Paz, Bolivia.',
    'Sede Técnica: Calle Otero de la Vega N° 295, Zona San Pedro, La Paz, Bolivia.',
    '',
    'Aviso Legal: AV FINANCE S.R.L. es una entidad supervisada por la Autoridad de',
    'Supervisión del Sistema Financiero (ASFI). Las operaciones realizadas a través de la',
    'plataforma "Alyto" se encuentran sujetas a la normativa vigente del Sistema Financiero',
    'Nacional, la Ley N° 393 y las disposiciones de la UIF sobre Prevención de Legitimación',
    'de Ganancias Ilícitas. La información contenida en este mensaje es confidencial y',
    'exclusiva para su destinatario. La reproducción no autorizada está prohibida.',
    'El uso de la infraestructura Alyto implica la aceptación de nuestros Términos y',
    'Condiciones y nuestra Política de Privacidad de Datos.',
  ].join('\n'),

  // ── Valores por defecto que faltaban ──
  STELLAR_USDC_CODE:          'USDC',
  STELLAR_PRIORITY_FEE_STROOPS: '1000',
  QR_TTL_CHARGE:              '600',
  QR_TTL_P2P:                 '300',
  VITA_CACHE_TTL_MS:          '300000',
  VITA_REQUEST_TIMEOUT_MS:    '30000',
  CLP_USD_RATE:               '966',
  XLM_USD_RATE:               '0.12',
  USDC_LOW_BALANCE_THRESHOLD: '100',
  NOTIFICATION_TTL_DAYS:      '1825',
  COOKIE_DOMAIN:              '.alyto.app',
  SPA_ACCOUNT_HOLDER:         'AV Finance SpA',
};

// ─── Merge y actualización ────────────────────────────────────────────────────

async function main() {
  console.log(`\n[Patch] Cargando secret: ${SECRET_ID} (${REGION})`);

  const client = new SecretsManagerClient({ region: REGION });

  // Obtener el secret actual
  const { SecretString } = await client.send(
    new GetSecretValueCommand({ SecretId: SECRET_ID }),
  );

  const current = JSON.parse(SecretString);
  const before  = Object.keys(current).length;

  // Merge — PATCH sobreescribe claves existentes con los valores nuevos
  const updated = { ...current, ...PATCH };
  const after   = Object.keys(updated).length;

  // Guardar
  await client.send(new PutSecretValueCommand({
    SecretId:     SECRET_ID,
    SecretString: JSON.stringify(updated),
  }));

  console.log(`\n✅ Secret actualizado exitosamente.`);
  console.log(`   Variables antes : ${before}`);
  console.log(`   Variables ahora : ${after}`);
  console.log(`   Agregadas/updated: ${Object.keys(PATCH).length}`);
  console.log(`\n   Keys actualizadas:`);
  Object.keys(PATCH).forEach(k => console.log(`   ✓ ${k}`));
  console.log('\n[Patch] Eliminar este archivo del repo después de ejecutar.');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
