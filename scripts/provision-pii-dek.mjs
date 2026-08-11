/**
 * provision-pii-dek.mjs — Provisiona la Data Key (DEK) de cifrado PII (envelope).
 *
 * Genera UNA data key AES-256 con AWS KMS (`GenerateDataKey`) y muestra el
 * ciphertext (DEK envuelta por KMS) que hay que guardar en `PII_DATA_KEY_WRAPPED`
 * (AWS Secrets Manager / .env del entorno). El plaintext se descarta al instante.
 *
 * Correr UNA vez por entorno (staging y prod tienen DEKs distintas). El
 * EncryptionContext debe coincidir EXACTO con el de services/piiCrypto.js.
 *
 * Uso (dentro del container, para heredar KMS/creds del entorno):
 *   docker compose exec alyto-backend node scripts/provision-pii-dek.mjs
 *
 * Salida: la línea `PII_DATA_KEY_WRAPPED=...` para pegar en el secreto/entorno.
 * ⚠️ NO commitear el valor. Tras cargarlo + `PII_ENCRYPTION_ENABLED=true`, redeploy.
 */

import 'dotenv/config';
import { loadSecretsIntoEnv } from '../src/utils/awsSecrets.js';

await loadSecretsIntoEnv();

const { KMSClient, GenerateDataKeyCommand } = await import('@aws-sdk/client-kms');

const REGION  = process.env.AWS_REGION ?? 'us-east-1';
const KEY_ID  = process.env.PII_KMS_KEY_ID
  ?? process.env.USER_KEYPAIR_KMS_KEY_ID
  ?? process.env.AWS_SECRETS_KMS_KEY_ID;

if (!KEY_ID) {
  console.error('[provision-pii-dek] Falta PII_KMS_KEY_ID / USER_KEYPAIR_KMS_KEY_ID / AWS_SECRETS_KMS_KEY_ID.');
  process.exit(1);
}

// DEBE coincidir con KMS_ENC_CONTEXT en services/piiCrypto.js
const ENC_CONTEXT = { service: 'alyto-pii', purpose: 'field-encryption' };

const kms = new KMSClient({ region: REGION });

try {
  const res = await kms.send(new GenerateDataKeyCommand({
    KeyId:             KEY_ID,
    KeySpec:           'AES_256',
    EncryptionContext: ENC_CONTEXT,
  }));

  // No imprimir NUNCA res.Plaintext. Solo el ciphertext envuelto.
  const wrapped = Buffer.from(res.CiphertextBlob).toString('base64');

  console.log('\n[provision-pii-dek] ✅ DEK generada y envuelta con KMS.');
  console.log(`[provision-pii-dek] KMS key: ${KEY_ID} | region: ${REGION}`);
  console.log('\nGuardá esta variable en el secreto/entorno (NO commitear):\n');
  console.log(`PII_DATA_KEY_WRAPPED=${wrapped}\n`);
  console.log('Luego: PII_ENCRYPTION_ENABLED=true + redeploy, y correr la migración.');
  process.exit(0);
} catch (err) {
  console.error('[provision-pii-dek] ❌ Error generando la DEK:', err.message);
  process.exit(1);
}
