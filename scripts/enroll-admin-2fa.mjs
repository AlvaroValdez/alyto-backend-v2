/**
 * enroll-admin-2fa.mjs — Alta del segundo factor de un operador, desde consola.
 *
 * Existe para resolver el arranque: `ADMIN_2FA_ENABLED` no puede encenderse hasta
 * que TODOS los operadores tengan su factor configurado, y la pantalla de alta
 * del panel vive en el repositorio del frontend. Sin esta vía habría que encender
 * la exigencia para poder cumplirla — que es el orden inverso al seguro.
 *
 * NO es un atajo: usa exactamente las mismas funciones del servicio que la vía
 * web, de modo que el secreto se cifra igual y el alta sigue exigiendo la
 * confirmación con un código válido. Un alta sin confirmar no habilita nada.
 *
 * Uso (dentro del contenedor, para heredar las credenciales del entorno):
 *   docker compose exec alyto-backend node scripts/enroll-admin-2fa.mjs --status
 *   docker compose exec -it alyto-backend node scripts/enroll-admin-2fa.mjs admin@alyto.app
 *
 * El modo `--status` no modifica nada: enumera qué cuentas con privilegios ya
 * tienen el factor y cuáles faltan. Es la comprobación previa al encendido.
 *
 * ⚠️ Requiere `PII_DATA_KEY_WRAPPED` provisionada (scripts/provision-pii-dek.mjs):
 * sin clave de datos el alta falla cerrado en vez de guardar el secreto en claro.
 * ⚠️ El secreto y los códigos de recuperación se muestran UNA vez, en pantalla.
 * Entregarlos por un canal que no quede registrado, y no dejarlos en el historial
 * de la terminal.
 */

import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import mongoose from 'mongoose';
import QRCode   from 'qrcode';

import { loadSecretsIntoEnv } from '../src/utils/awsSecrets.js';

await loadSecretsIntoEnv();

const User = (await import('../src/models/User.js')).default;
const {
  beginEnrollment, confirmEnrollment, enrollmentStatus, hasConfirmedSecondFactor,
} = await import('../src/services/adminTwoFactorService.js');

const arg = process.argv[2];

if (!arg) {
  console.error('Uso: node scripts/enroll-admin-2fa.mjs <correo del operador> | --status');
  process.exit(1);
}

if (!process.env.MONGODB_URI) {
  console.error('Falta MONGODB_URI.');
  process.exit(1);
}

await mongoose.connect(process.env.MONGODB_URI);

try {
  if (arg === '--status') {
    await mostrarEstado();
  } else {
    await darDeAlta(arg);
  }
} finally {
  await mongoose.disconnect();
}

// Salida explícita. En producción el registro estructurado agrega un transporte
// hacia el servicio de observabilidad que mantiene un temporizador de descarga
// abierto, y eso basta para que el proceso no termine nunca por sí solo: el
// script quedaba colgado justo en el entorno donde tiene que correr. En
// desarrollo no se nota, porque ese transporte no se activa.
process.exit(process.exitCode ?? 0);

// ─── Modos ────────────────────────────────────────────────────────────────────

async function mostrarEstado() {
  const { total, enrolled, pending, policy } = await enrollmentStatus();

  console.log('\nSegundo factor de accesos con privilegios');
  console.log('─'.repeat(58));
  console.log(`Exigencia activa (ADMIN_2FA_ENABLED): ${policy.enabled ? 'SÍ' : 'no'}`);
  console.log(`Método: ${policy.algorithm} · ${policy.digits} dígitos · paso ${policy.stepSeconds}s · tolerancia ±${policy.window}`);
  console.log(`Cuentas con privilegios activas: ${total}`);
  console.log(`Con segundo factor configurado:  ${enrolled}`);

  if (pending.length === 0) {
    console.log('\n✅ Todas las cuentas con privilegios tienen segundo factor.');
    console.log('   Se puede encender ADMIN_2FA_ENABLED=true y redesplegar.');
  } else {
    console.log(`\n⚠️  Faltan ${pending.length}. NO encender la exigencia todavía:`);
    for (const p of pending) console.log(`   · ${p.email}`);
  }
  console.log('');
}

async function darDeAlta(email) {
  const normalizado = String(email).toLowerCase().trim();
  const user = await User.findOne({ email: normalizado }).select('email role isActive twoFactor').lean();

  if (!user) {
    console.error(`No existe una cuenta con el correo ${normalizado}.`);
    process.exitCode = 1;
    return;
  }
  if (user.role !== 'admin') {
    console.error(`La cuenta ${normalizado} no tiene privilegios de administración; el segundo factor no le aplica.`);
    process.exitCode = 1;
    return;
  }
  if (hasConfirmedSecondFactor(user)) {
    console.error(`La cuenta ${normalizado} YA tiene segundo factor configurado.`);
    console.error('Reconfigurarlo es un restablecimiento y exige motivo: POST /api/v1/admin/users/:userId/2fa/reset');
    process.exitCode = 1;
    return;
  }

  // Se usa el URI que devuelve el servicio, no uno reconstruido aquí: el emisor
  // que muestra la aplicación de autenticación distingue el entorno, y armarlo
  // por separado hacía que el alta por consola etiquetara la cuenta distinto que
  // el alta por la web.
  const { manualEntry, otpauthUri: uri } = await beginEnrollment({ userId: user._id });

  console.log(`\nAlta del segundo factor — ${user.email}\n`);
  console.log(await QRCode.toString(uri, { type: 'terminal', small: true }));
  console.log(`Si el código no se lee, ingresar la clave a mano:\n\n    ${manualEntry}\n`);
  console.log('Escanear con la aplicación de autenticación y escribir un código para confirmar.');
  console.log('Mientras no se confirme, la cuenta sigue SIN segundo factor.\n');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (let intento = 1; intento <= 3; intento++) {
      const code = (await rl.question(`Código de 6 dígitos (intento ${intento}/3): `)).trim();
      const res = await confirmEnrollment({ userId: user._id, code });

      if (res.ok) {
        console.log('\n✅ Segundo factor activado.\n');
        console.log('Códigos de recuperación — de un solo uso, se muestran UNA vez:\n');
        for (const c of res.recoveryCodes) console.log(`    ${c}`);
        console.log('\nEntregarlos al operador por un canal seguro y que los guarde fuera del teléfono.');
        console.log('No quedan recuperables: si se pierden, hay que restablecer el factor con motivo.\n');
        return;
      }

      console.log(`  ✗ Código no válido (${res.reason}).`);
    }

    console.error('\nAlta no confirmada tras 3 intentos. La cuenta queda SIN segundo factor.');
    console.error('Comprobar que la hora del teléfono esté sincronizada y repetir el alta.\n');
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}
