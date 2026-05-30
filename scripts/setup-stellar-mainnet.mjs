#!/usr/bin/env node
/**
 * setup-stellar-mainnet.mjs — Setup completo de cuentas Stellar Mainnet para Alyto V2.0
 *
 * MODOS DE USO:
 *
 *   node scripts/setup-stellar-mainnet.mjs --generate
 *     Genera 4 nuevos keypairs mainnet (Master/Channel, SRL, SpA, LLC).
 *     Imprime public keys y las vars de entorno necesarias.
 *     GUARDAR el output en un lugar seguro — las secret keys NO se vuelven a mostrar.
 *
 *   node scripts/setup-stellar-mainnet.mjs --check
 *     Verifica que las cuentas configuradas en .env existen en mainnet,
 *     tienen saldo XLM suficiente y tienen trustline USDC activa.
 *     Requiere que el .env tenga las STELLAR_*_PUBLIC_KEY vars ya seteadas.
 *
 *   node scripts/setup-stellar-mainnet.mjs --setup-trustlines
 *     Crea la trustline USDC en cada cuenta que aún no la tenga.
 *     Requiere STELLAR_NETWORK=mainnet y todas las STELLAR_*_SECRET_KEY vars.
 *     Cada trustline se paga desde la cuenta misma (se requiere ~1.5 XLM mínimo).
 *
 *   node scripts/setup-stellar-mainnet.mjs --verify-audit
 *     Envía un memo de prueba de $0.01 USDC desde SRL a SRL para verificar
 *     que el audit trail funciona en mainnet. Requiere saldo USDC en SRL.
 *
 * FLUJO RECOMENDADO:
 *   1. --generate          → guardar keypairs en Secrets Manager
 *   2. Fondear manualmente cada cuenta con XLM (ver montos recomendados abajo)
 *   3. --check             → verificar que las cuentas existen y tienen XLM
 *   4. --setup-trustlines  → crear trustlines USDC en todas las cuentas
 *   5. --check             → verificar trustlines activas
 *   6. Activar en producción: STELLAR_NETWORK=mainnet en VPS y Render
 *
 * MONTOS XLM RECOMENDADOS POR CUENTA:
 *   MASTER/CHANNEL : 100 XLM  (paga fees de todos los usuarios — alta rotación)
 *   SRL            :  20 XLM  (paga trustline + buffer para operaciones)
 *   SpA            :  10 XLM  (buffer conservador, menor volumen)
 *   LLC            :  10 XLM  (institucional, bajo volumen inicial)
 *
 * SEGURIDAD:
 *   - Este script NUNCA imprime secret keys en modo --check o --verify-audit
 *   - En modo --generate imprime las secret keys UNA VEZ — guardéalas inmediatamente
 *   - NUNCA commitear este archivo con keypairs hardcodeados
 */

import 'dotenv/config';
import {
  Keypair,
  Asset,
  TransactionBuilder,
  Operation,
  Networks,
  Horizon,
} from '@stellar/stellar-sdk';

// ─── Configuración ────────────────────────────────────────────────────────────

const MAINNET_HORIZON   = 'https://horizon.stellar.org';
const MAINNET_PASSPHRASE = Networks.PUBLIC;
const USDC_ISSUER_MAINNET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const USDC_ASSET = new Asset('USDC', USDC_ISSUER_MAINNET);

const PRIORITY_FEE = process.env.STELLAR_PRIORITY_FEE_STROOPS || '1000';

const server = new Horizon.Server(MAINNET_HORIZON);

const MODE = process.argv[2];

// ─── Cuentas a gestionar ──────────────────────────────────────────────────────

const ACCOUNTS = [
  {
    name:       'MASTER/CHANNEL',
    secretEnv:  'STELLAR_MASTER_SECRET',
    publicEnv:  'STELLAR_MASTER_PUBLIC',
    xlmRecomendado: 100,
    esChannel:  true,
    descripcion: 'Cuenta canal: paga fees XLM de TODAS las transacciones de usuarios (Fee Bump)',
  },
  {
    name:       'SRL',
    secretEnv:  'STELLAR_SRL_SECRET_KEY',
    publicEnv:  'STELLAR_SRL_PUBLIC_KEY',
    xlmRecomendado: 20,
    descripcion: 'AV Finance SRL (Bolivia) — recibe y envía USDC para corredores BOB',
  },
  {
    name:       'SpA',
    secretEnv:  'STELLAR_SPA_SECRET_KEY',
    publicEnv:  'STELLAR_SPA_PUBLIC_KEY',
    xlmRecomendado: 10,
    descripcion: 'AV Finance SpA (Chile) — audit trail CLP→USDC',
  },
  {
    name:       'LLC',
    secretEnv:  'STELLAR_LLC_SECRET_KEY',
    publicEnv:  'STELLAR_LLC_PUBLIC_KEY',
    xlmRecomendado: 10,
    descripcion: 'AV Finance LLC (Delaware) — on-ramp institucional Harbor',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function separator(char = '═', len = 60) {
  console.log(char.repeat(len));
}

function banner(title) {
  separator();
  console.log(`  ${title}`);
  separator();
}

async function getAccountSafe(publicKey) {
  try {
    return await server.loadAccount(publicKey);
  } catch (err) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

function getUSDCBalance(account) {
  const b = account.balances.find(
    b => b.asset_type !== 'native' &&
         b.asset_code === 'USDC' &&
         b.asset_issuer === USDC_ISSUER_MAINNET
  );
  return b ? parseFloat(b.balance) : null;
}

function getXLMBalance(account) {
  const b = account.balances.find(b => b.asset_type === 'native');
  return b ? parseFloat(b.balance) : 0;
}

function hasTrustline(account) {
  return getUSDCBalance(account) !== null;
}

// ─── MODO: --generate ─────────────────────────────────────────────────────────

function modeGenerate() {
  banner('Alyto Stellar — Generación de Keypairs Mainnet');
  console.log();
  console.log('  ⚠️  ATENCIÓN: Las SECRET KEYS se muestran UNA SOLA VEZ.');
  console.log('  Guárdalas inmediatamente en AWS Secrets Manager.');
  console.log('  NUNCA las commitees ni las compartas por email/Slack.');
  console.log();
  separator('─');
  console.log();

  const pairs = {};

  for (const account of ACCOUNTS) {
    const kp = Keypair.random();
    pairs[account.name] = { public: kp.publicKey(), secret: kp.secret() };

    console.log(`  📍 ${account.name}`);
    console.log(`     ${account.descripcion}`);
    console.log(`     PUBLIC  (${account.publicEnv}): ${kp.publicKey()}`);
    console.log(`     SECRET  (${account.secretEnv}): ${kp.secret()}`);
    console.log(`     XLM recomendado para fondear: ${account.xlmRecomendado} XLM`);
    console.log();
  }

  separator('─');
  console.log();
  console.log('  📋 VARS DE ENTORNO para AWS Secrets Manager / .env:');
  console.log();

  for (const account of ACCOUNTS) {
    const { public: pub, secret } = pairs[account.name];
    console.log(`  ${account.publicEnv}=${pub}`);
    console.log(`  ${account.secretEnv}=${secret}`);
  }

  console.log();
  console.log('  Vars adicionales a actualizar:');
  console.log('  STELLAR_NETWORK=mainnet');
  console.log('  STELLAR_HORIZON_URL=https://horizon.stellar.org');
  console.log(`  STELLAR_USDC_ISSUER=${USDC_ISSUER_MAINNET}`);
  console.log('  STELLAR_USDC_CODE=USDC');
  console.log();

  separator('─');
  console.log();
  console.log('  💰 FONDEO REQUERIDO (comprar XLM en exchange y enviar a las public keys):');
  console.log();
  let totalXLM = 0;
  for (const account of ACCOUNTS) {
    const { public: pub } = pairs[account.name];
    console.log(`  ${account.name}: ${pub}`);
    console.log(`    → Enviar mínimo ${account.xlmRecomendado} XLM`);
    totalXLM += account.xlmRecomendado;
  }
  console.log();
  console.log(`  Total XLM a comprar: ~${totalXLM} XLM`);
  console.log(`  Al precio actual (~$0.12/XLM): ~$${(totalXLM * 0.12).toFixed(0)} USD`);
  console.log();
  console.log('  Después de fondear, ejecutar:');
  console.log('  node scripts/setup-stellar-mainnet.mjs --check');
  console.log();
  separator();
}

// ─── MODO: --check ────────────────────────────────────────────────────────────

async function modeCheck() {
  banner('Alyto Stellar — Verificación de Cuentas Mainnet');
  console.log();

  let allOk = true;

  for (const account of ACCOUNTS) {
    const publicKey = process.env[account.publicEnv];

    console.log(`  📍 ${account.name} (${account.publicEnv})`);

    if (!publicKey) {
      console.log(`     ❌ VAR NO CONFIGURADA — setear ${account.publicEnv} en .env`);
      allOk = false;
      console.log();
      continue;
    }

    console.log(`     Dirección: ${publicKey}`);

    const acc = await getAccountSafe(publicKey);

    if (!acc) {
      console.log(`     ❌ CUENTA NO EXISTE EN MAINNET — fondear con mínimo ${account.xlmRecomendado} XLM`);
      console.log(`     Link: https://stellar.expert/explorer/public/account/${publicKey}`);
      allOk = false;
      console.log();
      continue;
    }

    const xlm = getXLMBalance(acc);
    const usdc = getUSDCBalance(acc);
    const xlmOk = xlm >= (account.esChannel ? 20 : 5);
    const trustlineOk = usdc !== null;

    console.log(`     XLM:      ${xlm.toFixed(7)} XLM ${xlmOk ? '✅' : `⚠️  (recomendado: ${account.xlmRecomendado} XLM)`}`);

    if (trustlineOk) {
      console.log(`     USDC:     ${usdc.toFixed(7)} USDC ✅ (trustline activa)`);
    } else {
      console.log(`     USDC:     ❌ Sin trustline — ejecutar --setup-trustlines`);
      allOk = false;
    }

    if (!xlmOk) allOk = false;

    console.log(`     Explorer: https://stellar.expert/explorer/public/account/${publicKey}`);
    console.log();
  }

  separator('─');
  if (allOk) {
    console.log();
    console.log('  ✅ Todas las cuentas están configuradas y listas para mainnet.');
    console.log('  Siguiente paso: activar STELLAR_NETWORK=mainnet en VPS y Render.');
  } else {
    console.log();
    console.log('  ⚠️  Hay cuentas que requieren atención. Ver detalles arriba.');
  }
  console.log();
  separator();
}

// ─── MODO: --setup-trustlines ─────────────────────────────────────────────────

async function modeSetupTrustlines() {
  banner('Alyto Stellar — Creación de Trustlines USDC Mainnet');
  console.log();
  console.log(`  Asset: USDC — ${USDC_ISSUER_MAINNET}`);
  console.log();

  // Verificar que estamos en mainnet (o que el usuario forzó con --force)
  const forceMainnet = process.argv.includes('--force');
  if (process.env.STELLAR_NETWORK !== 'mainnet' && !forceMainnet) {
    console.error('  ❌ STELLAR_NETWORK no es "mainnet" en tu .env.');
    console.error('  Setea STELLAR_NETWORK=mainnet antes de crear trustlines en mainnet.');
    console.error('  O usa --force para omitir esta verificación (solo si sabes lo que haces).');
    process.exit(1);
  }

  // La cuenta channel firma las fee bumps — se necesita su secret
  const channelSecret = process.env.STELLAR_MASTER_SECRET;
  if (!channelSecret) {
    console.error('  ❌ STELLAR_MASTER_SECRET no configurado. Requerido para Fee Bump.');
    process.exit(1);
  }
  const channelKeypair = Keypair.fromSecret(channelSecret);

  for (const account of ACCOUNTS) {
    const secretKey = process.env[account.secretEnv];
    const publicKey = process.env[account.publicEnv];

    console.log(`  📍 ${account.name}`);

    if (!secretKey || !publicKey) {
      console.log(`     ⚠️  Vars no configuradas (${account.secretEnv} / ${account.publicEnv}) — omitiendo`);
      console.log();
      continue;
    }

    // Verificar cuenta en mainnet
    const acc = await getAccountSafe(publicKey);
    if (!acc) {
      console.log(`     ❌ Cuenta no existe en mainnet — fondear primero con XLM`);
      console.log();
      continue;
    }

    // Verificar si ya tiene trustline
    if (hasTrustline(acc)) {
      const usdc = getUSDCBalance(acc);
      console.log(`     ✅ Trustline USDC ya existe (saldo: ${usdc.toFixed(7)} USDC) — omitiendo`);
      console.log();
      continue;
    }

    const xlm = getXLMBalance(acc);
    if (xlm < 1.5) {
      console.log(`     ❌ Saldo XLM insuficiente (${xlm.toFixed(7)} XLM). Mínimo 1.5 XLM para trustline.`);
      console.log();
      continue;
    }

    console.log(`     Creando trustline USDC...`);

    try {
      const signer = Keypair.fromSecret(secretKey);

      // Inner transaction: changeTrust
      const innerTx = new TransactionBuilder(acc, {
        fee: BASE_FEE,
        networkPassphrase: MAINNET_PASSPHRASE,
      })
        .addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
        .setTimeout(30)
        .build();

      innerTx.sign(signer);

      // Fee Bump: channel paga los fees (Regla de Oro)
      const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
        channelKeypair,
        PRIORITY_FEE,
        innerTx,
        MAINNET_PASSPHRASE,
      );
      feeBumpTx.sign(channelKeypair);

      const result = await server.submitTransaction(feeBumpTx);
      console.log(`     ✅ Trustline USDC creada`);
      console.log(`     TX: https://stellar.expert/explorer/public/tx/${result.hash}`);
    } catch (err) {
      const detail = err?.response?.data?.extras?.result_codes ?? err.message;
      console.error(`     ❌ Error creando trustline: ${JSON.stringify(detail)}`);
    }

    console.log();
  }

  separator('─');
  console.log();
  console.log('  Verificar resultado:');
  console.log('  node scripts/setup-stellar-mainnet.mjs --check');
  console.log();
  separator();
}

const BASE_FEE = '200';

// ─── MODO: --verify-audit ─────────────────────────────────────────────────────

async function modeVerifyAudit() {
  banner('Alyto Stellar — Verificación Audit Trail Mainnet');
  console.log();
  console.log('  Enviando operación de prueba: SRL → SRL (self-transfer $0.00001 USDC con memo)');
  console.log();

  if (process.env.STELLAR_NETWORK !== 'mainnet') {
    console.error('  ❌ STELLAR_NETWORK no es "mainnet" — setear antes de verificar audit trail.');
    process.exit(1);
  }

  const srlSecret = process.env.STELLAR_SRL_SECRET_KEY;
  const srlPublic = process.env.STELLAR_SRL_PUBLIC_KEY;
  const masterSecret = process.env.STELLAR_MASTER_SECRET;

  if (!srlSecret || !srlPublic || !masterSecret) {
    console.error('  ❌ STELLAR_SRL_SECRET_KEY, STELLAR_SRL_PUBLIC_KEY y STELLAR_MASTER_SECRET son requeridos.');
    process.exit(1);
  }

  const srlKeypair     = Keypair.fromSecret(srlSecret);
  const channelKeypair = Keypair.fromSecret(masterSecret);
  const acc            = await getAccountSafe(srlPublic);

  if (!acc) {
    console.error('  ❌ Cuenta SRL no existe en mainnet.');
    process.exit(1);
  }

  if (!hasTrustline(acc)) {
    console.error('  ❌ Cuenta SRL no tiene trustline USDC. Ejecutar --setup-trustlines primero.');
    process.exit(1);
  }

  const usdc = getUSDCBalance(acc);
  if (usdc < 0.001) {
    console.error(`  ❌ Saldo USDC insuficiente (${usdc} USDC). Depositar al menos 0.001 USDC en SRL para la prueba.`);
    process.exit(1);
  }

  try {
    const memo = `ALYTO_AUDIT_TEST_${Date.now()}`;
    const innerTx = new TransactionBuilder(acc, {
      fee:              BASE_FEE,
      networkPassphrase: MAINNET_PASSPHRASE,
    })
      .addOperation(Operation.payment({
        destination: srlPublic,           // self-transfer — no mueve fondos reales
        asset:       USDC_ASSET,
        amount:      '0.0000001',
      }))
      .addMemo(Memo.text(memo.slice(0, 28)))
      .setTimeout(30)
      .build();

    innerTx.sign(srlKeypair);

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      channelKeypair,
      PRIORITY_FEE,
      innerTx,
      MAINNET_PASSPHRASE,
    );
    feeBumpTx.sign(channelKeypair);

    const result = await server.submitTransaction(feeBumpTx);

    console.log('  ✅ Audit trail funcionando en mainnet');
    console.log(`  TX Hash: ${result.hash}`);
    console.log(`  Explorer: https://stellar.expert/explorer/public/tx/${result.hash}`);
    console.log();
    console.log('  El sistema está listo para activar STELLAR_NETWORK=mainnet en producción.');
  } catch (err) {
    const detail = err?.response?.data?.extras?.result_codes ?? err.message;
    console.error('  ❌ Error en audit trail de prueba:', JSON.stringify(detail));
  }

  console.log();
  separator();
}

// Importar Memo para modeVerifyAudit
import { Memo } from '@stellar/stellar-sdk';

// ─── Dispatcher ──────────────────────────────────────────────────────────────

switch (MODE) {
  case '--generate':
    modeGenerate();
    break;
  case '--check':
    await modeCheck();
    break;
  case '--setup-trustlines':
    await modeSetupTrustlines();
    break;
  case '--verify-audit':
    await modeVerifyAudit();
    break;
  default:
    console.log(`
Alyto Stellar Mainnet Setup — Uso:

  node scripts/setup-stellar-mainnet.mjs --generate
    Genera 4 nuevos keypairs. Guardar en Secrets Manager inmediatamente.

  node scripts/setup-stellar-mainnet.mjs --check
    Verifica cuentas en mainnet (saldo XLM + trustline USDC).
    Requiere STELLAR_*_PUBLIC_KEY en .env.

  node scripts/setup-stellar-mainnet.mjs --setup-trustlines
    Crea trustline USDC en cuentas que aún no la tienen.
    Requiere STELLAR_NETWORK=mainnet y todas las STELLAR_*_SECRET_KEY.

  node scripts/setup-stellar-mainnet.mjs --verify-audit
    Test de audit trail: self-transfer SRL + Fee Bump.
    Requiere saldo USDC en cuenta SRL.

Flujo recomendado: --generate → fondear → --check → --setup-trustlines → --check → --verify-audit
`);
}
