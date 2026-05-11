#!/usr/bin/env node
/**
 * fund-srl-usdc.js — Cargar USDC al wallet Stellar SRL
 *
 * Uso:
 *   node scripts/fund-srl-usdc.js           → carga 500 USDC (default)
 *   node scripts/fund-srl-usdc.js 250        → carga 250 USDC
 *   node scripts/fund-srl-usdc.js 1000       → carga 1000 USDC
 *
 * Fuente: STELLAR_MASTER_PUBLIC → STELLAR_SRL_PUBLIC_KEY
 * Si el master no tiene suficiente USDC, intenta path payment XLM→USDC.
 *
 * Variables requeridas en .env:
 *   STELLAR_MASTER_SECRET
 *   STELLAR_MASTER_PUBLIC
 *   STELLAR_SRL_PUBLIC_KEY
 *   STELLAR_USDC_ISSUER
 *   STELLAR_HORIZON_URL
 *   STELLAR_NETWORK (testnet | mainnet)
 */

import 'dotenv/config';
import StellarSdk from '@stellar/stellar-sdk';

// ── Config ────────────────────────────────────────────────────────────────────
const AMOUNT      = process.argv[2] ?? '500';
const NETWORK     = process.env.STELLAR_NETWORK ?? 'testnet';
const HORIZON_URL = process.env.STELLAR_HORIZON_URL
  ?? (NETWORK === 'mainnet'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org');

const MASTER_SECRET = process.env.STELLAR_MASTER_SECRET;
const MASTER_PUBLIC = process.env.STELLAR_MASTER_PUBLIC;
const SRL_PUBLIC    = process.env.STELLAR_SRL_PUBLIC_KEY;
const USDC_ISSUER   = process.env.STELLAR_USDC_ISSUER;

// ── Validaciones ──────────────────────────────────────────────────────────────
const errors = [];
if (!MASTER_SECRET || MASTER_SECRET.includes('TU'))
  errors.push('STELLAR_MASTER_SECRET no configurada o es placeholder');
if (!SRL_PUBLIC)
  errors.push('STELLAR_SRL_PUBLIC_KEY no configurada');
if (!USDC_ISSUER)
  errors.push('STELLAR_USDC_ISSUER no configurada');
if (isNaN(parseFloat(AMOUNT)) || parseFloat(AMOUNT) <= 0)
  errors.push(`Monto inválido: ${AMOUNT}`);

if (errors.length > 0) {
  console.error('\n❌ Errores de configuración:');
  errors.forEach(e => console.error(`   - ${e}`));
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const colors = {
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
  reset:  '\x1b[0m',
};
const ok   = msg => console.log(`${colors.green}✅ ${msg}${colors.reset}`);
const warn = msg => console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`);
const err  = msg => console.log(`${colors.red}❌ ${msg}${colors.reset}`);
const info = msg => console.log(`${colors.cyan}ℹ  ${msg}${colors.reset}`);

async function getUSDCBalance(server, address) {
  const account = await server.loadAccount(address);
  const usdc = account.balances.find(b =>
    b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER
  );
  const xlm = account.balances.find(b => b.asset_type === 'native');
  return {
    usdc: parseFloat(usdc?.balance ?? 0),
    xlm:  parseFloat(xlm?.balance  ?? 0),
    hasTrustline: !!usdc,
    account,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${colors.bold}${colors.cyan}╔══════════════════════════════════════════╗`);
  console.log(`║   Fund SRL USDC — Alyto Wallet          ║`);
  console.log(`╚══════════════════════════════════════════╝${colors.reset}`);

  const server      = new StellarSdk.Horizon.Server(HORIZON_URL);
  const masterKP    = StellarSdk.Keypair.fromSecret(MASTER_SECRET);
  const usdcAsset   = new StellarSdk.Asset('USDC', USDC_ISSUER);
  const networkPass = NETWORK === 'mainnet'
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET;

  // Verificar que el secret corresponde al public correcto
  if (masterKP.publicKey() !== MASTER_PUBLIC) {
    warn(`STELLAR_MASTER_SECRET no corresponde a STELLAR_MASTER_PUBLIC`);
    warn(`Secret deriva: ${masterKP.publicKey()}`);
    warn(`Public en .env: ${MASTER_PUBLIC}`);
    warn('Usando la public derivada del secret (es la correcta)');
  }

  console.log(`\nRed:       ${NETWORK.toUpperCase()}`);
  console.log(`Monto:     ${AMOUNT} USDC`);
  console.log(`Origen:    ${masterKP.publicKey().slice(0,8)}...`);
  console.log(`Destino:   ${SRL_PUBLIC.slice(0,8)}...\n`);

  // ── PASO 1: Ver balances actuales ──────────────────────────────────────────
  info('Consultando balances...');
  const [master, srl] = await Promise.all([
    getUSDCBalance(server, masterKP.publicKey()),
    getUSDCBalance(server, SRL_PUBLIC),
  ]);

  console.log(`\nMaster wallet:`);
  console.log(`  XLM:  ${master.xlm.toFixed(7)}`);
  console.log(`  USDC: ${master.usdc.toFixed(7)}`);
  console.log(`\nSRL wallet:`);
  console.log(`  XLM:  ${srl.xlm.toFixed(7)}`);
  console.log(`  USDC: ${srl.usdc.toFixed(7)}`);

  const amountFloat = parseFloat(AMOUNT);

  // ── PASO 2: Verificar trustline USDC en SRL ────────────────────────────────
  if (!srl.hasTrustline) {
    err('SRL wallet no tiene trustline USDC. Ejecutar trustline-setup.js primero.');
    process.exit(1);
  }

  // ── PASO 3: Si master tiene suficiente USDC → transferencia directa ───────
  if (master.usdc >= amountFloat) {
    info(`Master tiene ${master.usdc.toFixed(2)} USDC → transferencia directa`);

    const freshAccount = await server.loadAccount(masterKP.publicKey());

    const tx = new StellarSdk.TransactionBuilder(freshAccount, {
      fee:              StellarSdk.BASE_FEE,
      networkPassphrase: networkPass,
    })
    .addOperation(StellarSdk.Operation.payment({
      destination: SRL_PUBLIC,
      asset:       usdcAsset,
      amount:      AMOUNT,
    }))
    .setTimeout(30)
    .build();

    tx.sign(masterKP);

    info('Enviando transacción Stellar...');
    const result = await server.submitTransaction(tx);
    ok(`Transacción confirmada: ${result.hash}`);
    info(`Explorer: https://stellar.expert/explorer/${NETWORK}/tx/${result.hash}`);

  // ── PASO 4: Si master NO tiene suficiente USDC → path payment XLM→USDC ───
  } else {
    warn(`Master solo tiene ${master.usdc.toFixed(2)} USDC — menos de ${AMOUNT}`);
    info(`Intentando path payment XLM → USDC (usando ${master.xlm.toFixed(0)} XLM disponibles)...`);

    if (NETWORK === 'mainnet') {
      err('En mainnet no se puede hacer path payment XLM→USDC automáticamente.');
      err('Fondea el master wallet manualmente con USDC via Binance → Stellar.');
      process.exit(1);
    }

    // Solo en testnet: path payment XLM→USDC via DEX
    const freshAccount = await server.loadAccount(masterKP.publicKey());

    // Crear trustline si no existe en master
    if (!master.hasTrustline) {
      info('Creando trustline USDC en master...');
      const trustTx = new StellarSdk.TransactionBuilder(freshAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: networkPass,
      })
      .addOperation(StellarSdk.Operation.changeTrust({
        asset:  usdcAsset,
        limit:  '100000',
      }))
      .setTimeout(30)
      .build();
      trustTx.sign(masterKP);
      await server.submitTransaction(trustTx);
      ok('Trustline USDC creada en master');
      await new Promise(r => setTimeout(r, 3000));
    }

    // Path payment: quiero recibir AMOUNT USDC, pago en XLM
    const freshAccount2 = await server.loadAccount(masterKP.publicKey());
    const XLM_MAX = Math.min(master.xlm - 10, 5000).toFixed(7); // reservar 10 XLM

    const pathTx = new StellarSdk.TransactionBuilder(freshAccount2, {
      fee:              '10000',
      networkPassphrase: networkPass,
    })
    .addOperation(StellarSdk.Operation.pathPaymentStrictReceive({
      sendAsset:   StellarSdk.Asset.native(),
      sendMax:     XLM_MAX,
      destination: masterKP.publicKey(),
      destAsset:   usdcAsset,
      destAmount:  AMOUNT,
      path:        [],
    }))
    .setTimeout(30)
    .build();

    pathTx.sign(masterKP);

    info('Ejecutando path payment XLM → USDC...');
    try {
      const result = await server.submitTransaction(pathTx);
      ok(`Path payment exitoso: ${result.hash}`);

      // Ahora transferir al SRL
      await new Promise(r => setTimeout(r, 2000));
      const acct3 = await server.loadAccount(masterKP.publicKey());

      const transferTx = new StellarSdk.TransactionBuilder(acct3, {
        fee:              StellarSdk.BASE_FEE,
        networkPassphrase: networkPass,
      })
      .addOperation(StellarSdk.Operation.payment({
        destination: SRL_PUBLIC,
        asset:       usdcAsset,
        amount:      AMOUNT,
      }))
      .setTimeout(30)
      .build();
      transferTx.sign(masterKP);

      const r2 = await server.submitTransaction(transferTx);
      ok(`Transferencia SRL exitosa: ${r2.hash}`);
      info(`Explorer: https://stellar.expert/explorer/${NETWORK}/tx/${r2.hash}`);

    } catch (pathErr) {
      const codes = pathErr.response?.data?.extras?.result_codes;
      err(`Path payment falló: ${JSON.stringify(codes)}`);
      err('El DEX puede no tener liquidez. Opciones:');
      console.log('  1. https://faucet.circle.com/ → 20 USDC cada 2h (testnet)');
      console.log('  2. Fondear master con USDC manualmente via Stellar Lab');
      console.log('  3. Ejecutar con monto menor: node scripts/fund-srl-usdc.js 200');
      process.exit(1);
    }
  }

  // ── PASO 5: Balance final ──────────────────────────────────────────────────
  await new Promise(r => setTimeout(r, 2000));
  const finalSrl    = await getUSDCBalance(server, SRL_PUBLIC);
  const finalMaster = await getUSDCBalance(server, masterKP.publicKey());

  console.log(`\n${colors.bold}Balances finales:${colors.reset}`);
  console.log(`  Master USDC: ${finalMaster.usdc.toFixed(7)}`);
  console.log(`  SRL USDC:    ${finalSrl.usdc.toFixed(7)}`);

  const expected = srl.usdc + amountFloat;
  if (Math.abs(finalSrl.usdc - expected) < 0.01) {
    ok(`SRL wallet fondeado correctamente (+${AMOUNT} USDC)`);
  } else {
    warn(`Balance SRL: esperado ~${expected.toFixed(2)}, obtenido ${finalSrl.usdc.toFixed(2)}`);
  }

  console.log();
}

main().catch(e => {
  console.error(`\n❌ Error inesperado: ${e.message}`);
  if (e.response?.data) {
    console.error('Stellar response:', JSON.stringify(e.response.data, null, 2));
  }
  process.exit(1);
});
