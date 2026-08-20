/**
 * provision-pii-dek.mjs — Provisiona la Data Key (DEK) de cifrado PII (envelope).
 *
 * Genera una DEK AES-256 ALEATORIA localmente y la ENVUELVE con AWS KMS
 * (`kms:Encrypt`), mostrando el ciphertext (DEK envuelta) que hay que guardar en
 * `PII_DATA_KEY_WRAPPED` (AWS Secrets Manager / .env del entorno). El plaintext de
 * la DEK se descarta (se zeroiza) al instante y NUNCA se imprime.
 *
 * ⚠️ Usa `kms:Encrypt` — el MISMO permiso que custodyService — y NO
 * `kms:GenerateDataKey`, que el rol de runtime de Alyto (`alyto-secrets-writer`)
 * no tiene autorizado. `services/piiCrypto.js` la desenvuelve con `kms:Decrypt`
 * usando el MISMO EncryptionContext.
 *
 * Correr UNA vez por entorno (staging y prod tienen DEKs distintas). Idempotencia:
 * cada corrida genera una DEK nueva — NO re-provisionar si ya hay datos cifrados
 * con la DEK vigente (perderías la capacidad de descifrarlos).
 *
 * Uso (dentro del container, para heredar KMS/creds del entorno):
 *   docker compose exec alyto-backend node scripts/provision-pii-dek.mjs
 *
 * Salida: la línea `PII_DATA_KEY_WRAPPED=...` para pegar en el secreto/entorno.
 * ⚠️ NO commitear el valor. Tras cargarlo + `PII_ENCRYPTION_ENABLED=true`, redeploy.
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import { loadSecretsIntoEnv } from '../src/utils/awsSecrets.js';

await loadSecretsIntoEnv();

const { KMSClient, EncryptCommand } = await import('@aws-sdk/client-kms');

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
  // DEK aleatoria de 256 bits (equivalente a GenerateDataKey, pero sin ese permiso).
  const dek = crypto.randomBytes(32);

  const res = await kms.send(new EncryptCommand({
    KeyId:             KEY_ID,
    Plaintext:         dek,
    EncryptionContext: ENC_CONTEXT,
  }));

  dek.fill(0); // zeroizar el plaintext de la DEK apenas queda envuelta

  // No imprimir NUNCA el plaintext. Solo el ciphertext envuelto por KMS.
  const wrapped = Buffer.from(res.CiphertextBlob).toString('base64');

  console.log('\n[provision-pii-dek] ✅ DEK generada y envuelta con KMS (Encrypt).');
  console.log(`[provision-pii-dek] KMS key: ${KEY_ID} | region: ${REGION}`);
  console.log('\nGuardá esta variable en el secreto/entorno (NO commitear):\n');
  console.log(`PII_DATA_KEY_WRAPPED=${wrapped}\n`);
  console.log('Luego: PII_ENCRYPTION_ENABLED=true + redeploy, y correr la migración.');
  process.exit(0);
} catch (err) {
  console.error('[provision-pii-dek] ❌ Error generando/envolviendo la DEK:', err.message);
  process.exit(1);
}
