#!/usr/bin/env node
/**
 * redenlace-e2e-dispersion.mjs — Certifica la dispersión contra el sandbox de ATC.
 *
 * A diferencia del cobro, acá **sale dinero** (del sandbox). El script no inventa
 * atajos: crea un retiro real en staging y lo despacha por el mismo controlador
 * que usa el admin, así que se ejercita el guard atómico pending→dispatched, la
 * resolución del proveedor por registro, la validación previa y el lote.
 *
 * La confirmación la manda ATC a staging. Funciona porque local y staging
 * comparten la base `alyto-v2-staging`: el alias que emitimos acá lo resuelve
 * staging allá.
 *
 * Uso:
 *   node scripts/redenlace-e2e-dispersion.mjs                      # ensayo
 *   node scripts/redenlace-e2e-dispersion.mjs --commit             # ejecuta
 *   node scripts/redenlace-e2e-dispersion.mjs --commit --monto 5
 *
 * ⚠️ Rechaza ejecutarse contra la base o la URL de producción.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (n) => process.argv.includes(`--${n}`);

const ok   = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const bad  = (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`  ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

const COMMIT = has('commit');
const MONTO  = Number(arg('monto', '1'));

// Cuenta destino de la prueba. Es la propia cuenta de comercio de certificación:
// el dinero sale y vuelve al mismo lugar, así que no se le regala saldo a nadie.
const DESTINO = {
  accountCode: arg('cuenta', process.env.REDENLACE_ACCOUNT),
  bankCode:    arg('banco', '1018'),
  name:        arg('titular', 'AV FINANCE SRL PRUEBA'),
  docId:       arg('ci', '2209426015'),
};

async function main() {
  head('1. Ambiente');

  const uri    = process.env.MONGODB_URI ?? '';
  const dbName = uri.match(/@[^/]+\/([^?]+)/)?.[1] ?? '';
  if (dbName === 'alyto-v2') { bad('MONGODB_URI apunta a PRODUCCIÓN. Abortando.'); process.exit(1); }
  if (!dbName)               { bad('MONGODB_URI no parseable.'); process.exit(1); }
  ok(`base: ${dbName}`);

  const base = String(process.env.REDENLACE_BASE_URL ?? '');
  if (base.includes('api.redenlace.com.bo')) {
    bad('REDENLACE_BASE_URL apunta a producción de ATC. Este script es solo para certificación.');
    process.exit(1);
  }
  ok(`ATC: ${base}`);

  const faltan = ['REDENLACE_CLIENT_ID', 'REDENLACE_CLIENT_SECRET', 'REDENLACE_BRANCH_CODE',
                  'REDENLACE_ACCOUNT', 'REDENLACE_PAYOUT_WEBHOOK_URL', 'REDENLACE_PAYOUT_WEBHOOK_TOKEN']
    .filter((k) => !process.env[k]);
  if (faltan.length) { bad(`faltan variables: ${faltan.join(', ')}`); process.exit(1); }
  ok('credenciales y webhook configurados');

  const gate = process.env.WALLET_REDENLACE_DISBURSEMENT_ENABLED === 'true';
  info(`gate de dispersión real: ${gate ? 'ENCENDIDO (va a mover dinero del sandbox)' : 'apagado (simula)'}`);

  // La URL del webhook es un secreto completo: lleva el token adentro.
  const url = process.env.REDENLACE_PAYOUT_WEBHOOK_URL;
  info(`webhook: ${url.split('?')[0]}?token=… (${url.length} caracteres)`);
  if (!url.includes(process.env.REDENLACE_PAYOUT_WEBHOOK_TOKEN)) {
    bad('La URL del webhook no contiene el token configurado. ATC notificaría y staging rechazaría.');
    process.exit(1);
  }
  ok('la URL y el token coinciden');

  head('2. Retiro de prueba');

  if (!DESTINO.accountCode) { bad('Falta cuenta destino (--cuenta o REDENLACE_ACCOUNT)'); process.exit(1); }
  info(`destino: ${DESTINO.bankCode}/${DESTINO.accountCode} · ${DESTINO.name} · CI ${DESTINO.docId}`);
  info(`monto  : Bs. ${MONTO.toFixed(2)}`);

  await mongoose.connect(uri);
  const User              = (await import('../src/models/User.js')).default;
  const WalletBOB         = (await import('../src/models/WalletBOB.js')).default;
  const WalletTransaction = (await import('../src/models/WalletTransaction.js')).default;

  const email = arg('email');
  const user  = email ? await User.findOne({ email })
                      : await User.findOne({ legalEntity: 'SRL' }).sort({ createdAt: 1 });
  if (!user) { bad('No encontré un usuario SRL. Pasá --email.'); await mongoose.disconnect(); process.exit(1); }
  ok(`usuario: ${user.email}`);

  let wallet = await WalletBOB.findOne({ userId: user._id });
  info(`saldo actual: ${wallet?.balance ?? 0} BOB · reservado: ${wallet?.balanceReserved ?? 0}`);

  if (!COMMIT) {
    head('Ensayo — no se escribió nada');
    info(`Se crearía un retiro pending de Bs. ${MONTO.toFixed(2)} con saldo reservado,`);
    info('se despacharía por adminDispatchWithdrawal y se esperaría la confirmación de ATC.');
    info('');
    info('Para ejecutarlo de verdad, agregá --commit');
    await mongoose.disconnect();
    return;
  }

  // Saldo suficiente, reservado: así lo deja `requestWithdrawal` en el flujo real.
  if (!wallet) wallet = await WalletBOB.create({ userId: user._id, balance: 0 });
  if (wallet.balance < MONTO) {
    await WalletBOB.updateOne({ _id: wallet._id }, { $inc: { balance: MONTO - wallet.balance } });
    info(`saldo insuficiente — se acreditan Bs. ${(MONTO - wallet.balance).toFixed(2)} para la prueba`);
  }
  await WalletBOB.updateOne({ _id: wallet._id }, { $inc: { balanceReserved: MONTO } });
  wallet = await WalletBOB.findById(wallet._id);

  const wtx = await WalletTransaction.create({
    walletId:      wallet._id,
    userId:        user._id,
    type:          'withdrawal',
    amount:        MONTO,
    balanceBefore: wallet.balance,
    balanceAfter:  wallet.balance,
    status:        'pending',
    currency:      'BOB',
    description:   'Prueba e2e dispersión Red Enlace',
    metadata: {
      method:        'bank',
      accountNumber: DESTINO.accountCode,
      accountHolder: DESTINO.name,
      accountType:   'caja de ahorro',
      bankCode:      DESTINO.bankCode,
    },
  });
  ok(`retiro creado: ${wtx.wtxId} (pending, saldo reservado)`);

  // ── Despacho por el camino real ────────────────────────────────────────────
  head('3. Despacho');

  const { adminDispatchWithdrawal } = await import('../src/controllers/walletController.js');

  const req = {
    user: { _id: user._id },
    body: {
      wtxId:            wtx.wtxId,
      provider:         'redenlace',
      beneficiaryDocId: DESTINO.docId,
    },
  };
  let salida = null;
  const res = {
    status(c) { this._c = c; return this; },
    json(b)   { salida = { code: this._c ?? 200, body: b }; return this; },
  };

  await adminDispatchWithdrawal(req, res);

  if (salida.code !== 200) {
    bad(`el despacho falló (HTTP ${salida.code}): ${salida.body?.error}`);
    const tras = await WalletTransaction.findById(wtx._id);
    info(`el retiro quedó en '${tras.status}' (debería volver a pending si no se movió dinero)`);
    await mongoose.disconnect();
    process.exit(1);
  }

  ok(`lote autorizado · nroLote ${salida.body.bankBatchId}${salida.body.mock ? ' (SIMULADO)' : ''}`);
  info(`proveedor: ${salida.body.provider} · estado: ${salida.body.status}`);

  const { resolveByReference } = await import('../src/services/bank/providerReference.js');
  const PR = (await import('../src/models/ProviderReference.js')).default;
  const alias = await PR.findOne({ targetId: wtx.wtxId, kind: 'payout' });
  if (alias) {
    info(`alias enviado a ATC: ${alias.reference} → referencia ATC: ${alias.externalReference ?? '(pendiente)'}`);
  }

  if (salida.body.mock) {
    head('Resultado');
    info('Fue una simulación: WALLET_REDENLACE_DISBURSEMENT_ENABLED no está en true.');
    info('ATC no recibió nada y no va a haber webhook.');
    await mongoose.disconnect();
    return;
  }

  // ── Esperar la confirmación ────────────────────────────────────────────────
  head('4. Confirmación de ATC');
  info('ATC notifica a staging cuando procesa la transacción. Esperando hasta 3 minutos...');

  const limite = Date.now() + 3 * 60 * 1000;
  let final = await WalletTransaction.findById(wtx._id);
  while (Date.now() < limite && final.status === 'dispatched') {
    await new Promise((r) => setTimeout(r, 5000));
    final = await WalletTransaction.findById(wtx._id);
    process.stdout.write('.');
  }
  console.log('');

  const wFinal = await WalletBOB.findById(wallet._id);

  head('5. Resultado');
  info(`estado del retiro : ${final.status}`);
  info(`saldo             : ${wallet.balance} → ${wFinal.balance} BOB`);
  info(`reservado         : ${wallet.balanceReserved} → ${wFinal.balanceReserved}`);

  if (final.status === 'completed') {
    ok('Camino completo: lote, webhook con token, traducción del alias y liquidación del saldo.');
  } else if (final.status === 'dispatched') {
    bad('No llegó la confirmación en 3 minutos.');
    info('Puede ser normal si ATC procesa en lote. Revisá los logs de staging buscando');
    info(`"redenlace Disbursement IPN". Para seguir el retiro: wtxId ${wtx.wtxId}`);
  } else {
    bad(`El retiro terminó en '${final.status}'. Revisá los logs de staging.`);
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  bad(e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
