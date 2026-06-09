// scripts/aws/update-secret-keys.mjs
//
// Actualiza/mergea claves arbitrarias en el secret de AWS Secrets Manager
// (alyto/production) sin tener que editar el JSON a mano.
//
// Requisitos: credenciales con secretsmanager:GetSecretValue + PutSecretValue
//   sobre alyto/production (el usuario runtime `alyto-secrets-writer` ya las tiene).
//
// Uso (KEY=VALUE como argumentos):
//   node scripts/aws/update-secret-keys.mjs \
//     S3_BUCKET=alyto-pdfs-compliance \
//     S3_REGION=us-east-1 \
//     S3_ENDPOINT= \
//     S3_OBJECT_LOCK_ENABLED=true \
//     S3_OBJECT_LOCK_DAYS=1825 \
//     S3_ACCESS_KEY_ID=AKIA... \
//     S3_SECRET_ACCESS_KEY=...
//
// Notas:
//   - `KEY=` (valor vacío) SÍ se escribe como string vacío (p.ej. S3_ENDPOINT= para
//     desactivar R2 y usar S3 nativo). Para BORRAR una clave usar el prefijo `-KEY`.
//   - Hace dry-run con --dry-run (no escribe, solo muestra el diff de claves).
//   - NUNCA imprime valores de secretos, solo nombres.

// dotenv eliminado — usar --env-file=.env (Node 20+) o configurar vars de entorno directamente.
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const SECRET_NAME = process.env.AWS_SECRETS_NAME || 'alyto/production';
const REGION = process.env.AWS_REGION || 'us-east-1';

const rawArgs = process.argv.slice(2);
const DRY_RUN = rawArgs.includes('--dry-run');
const pairs = rawArgs.filter((a) => a !== '--dry-run');

if (pairs.length === 0) {
  console.error('Uso: node scripts/aws/update-secret-keys.mjs KEY=VALUE [KEY2=VALUE2 ...] [-KEY_A_BORRAR] [--dry-run]');
  process.exit(1);
}

const setOps = {};
const delKeys = [];
for (const p of pairs) {
  if (p.startsWith('-') && !p.includes('=')) {
    delKeys.push(p.slice(1));
    continue;
  }
  const idx = p.indexOf('=');
  if (idx === -1) {
    console.error(`Argumento inválido (esperado KEY=VALUE): ${p}`);
    process.exit(1);
  }
  const key = p.slice(0, idx);
  const value = p.slice(idx + 1); // permite valor vacío
  setOps[key] = value;
}

async function main() {
  const client = new SecretsManagerClient({ region: REGION });

  const current = await client.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  const secretObj = JSON.parse(current.SecretString);
  console.log(`[update-secret] Secret "${SECRET_NAME}" tiene ${Object.keys(secretObj).length} campos`);

  const willAdd = [];
  const willChange = [];
  for (const [k, v] of Object.entries(setOps)) {
    if (!(k in secretObj)) willAdd.push(k);
    else if (secretObj[k] !== v) willChange.push(k);
  }
  const willDelete = delKeys.filter((k) => k in secretObj);

  console.log(`[update-secret] Agregar:  ${willAdd.join(', ') || '(ninguno)'}`);
  console.log(`[update-secret] Cambiar:  ${willChange.join(', ') || '(ninguno)'}`);
  console.log(`[update-secret] Borrar:   ${willDelete.join(', ') || '(ninguno)'}`);

  if (DRY_RUN) {
    console.log('[update-secret] --dry-run: no se escribió nada.');
    return;
  }

  const updated = { ...secretObj, ...setOps };
  for (const k of willDelete) delete updated[k];

  await client.send(new PutSecretValueCommand({
    SecretId: SECRET_NAME,
    SecretString: JSON.stringify(updated),
  }));

  console.log(`[update-secret] ✅ Secret actualizado: ${Object.keys(updated).length} campos totales.`);
  console.log('[update-secret] ⚠️ Reiniciar el backend (docker compose build + up) para tomar los cambios.');
}

main().catch((err) => {
  console.error('[update-secret] ❌ Error:', err.name, '::', err.message);
  process.exit(1);
});
