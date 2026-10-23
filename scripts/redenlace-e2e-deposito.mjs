#!/usr/bin/env node
/**
 * redenlace-e2e-deposito.mjs — Cierra el camino completo del cobro sin depender
 * de que ATC vuelva a simular un pago.
 *
 * ## Por qué esto no es hacer trampa
 *
 * Un webhook sintético NO puede acreditar saldo por sí solo: `verifyIpn` tiene
 * dos capas y la segunda le pregunta a ATC si el QR está pagado de verdad. Un
 * atacante que forje la notificación se estrella contra esa consulta.
 *
 * Lo que hace este script es apoyarse en un QR que ATC **ya marcó como PAGADO**
 * y que lo sigue reportando así cada vez que se consulta. Entonces:
 *
 *   - la validación de la cabecera se ejerce de verdad
 *   - el control de importe se ejerce de verdad
 *   - la segunda capa consulta a ATC y recibe PAGADO real
 *   - la acreditación de saldo ocurre por el camino de producción
 *
 * Lo único simulado es el disparo HTTP, porque ATC ya mandó el suyo y no lo
 * puede reenviar. Esa parte ya quedó probada por separado cuando su webhook
 * llegó a staging.
 *
 * ## Uso
 *
 *   node scripts/redenlace-e2e-deposito.mjs --qr 11195109              # ensayo
 *   node scripts/redenlace-e2e-deposito.mjs --qr 11195109 --commit     # ejecuta
 *
 * Opcional: --email usuario@dominio  (por defecto toma un usuario SRL de staging)
 *           --url https://...        (por defecto, el host de REDENLACE_QR_WEBHOOK_URL)
 *
 * ⚠️ Rechaza ejecutarse contra la base de producción.
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
const QR_ID  = arg('qr');

async function main() {
  if (!QR_ID) { bad('Falta --qr <numeroReferencia de ATC>'); process.exit(1); }

  // ── Guardas de ambiente ────────────────────────────────────────────────────
  head('1. Ambiente');

  const uri    = process.env.MONGODB_URI ?? '';
  const dbName = uri.match(/@[^/]+\/([^?]+)/)?.[1] ?? '';
  if (!dbName) { bad('MONGODB_URI no parseable'); process.exit(1); }
  if (dbName === 'alyto-v2') {
    bad('MONGODB_URI apunta a PRODUCCIÓN. Este script es solo para staging.');
    process.exit(1);
  }
  ok(`base: ${dbName}`);

  const base = (process.env.REDENLACE_BASE_URL ?? '').replace(/\/+$/, '');
  if (base.includes('api.redenlace.com.bo')) {
    bad('REDENLACE_BASE_URL apunta a producción de ATC. Abortando.');
    process.exit(1);
  }
  ok(`ATC: ${base}`);

  const webhookUrl = arg('url', process.env.REDENLACE_QR_WEBHOOK_URL);
  const headerKey  = process.env.REDENLACE_QR_WEBHOOK_KEY ?? 'x-api-key';
  const headerVal  = process.env.REDENLACE_QR_WEBHOOK_VALUE;
  if (!webhookUrl || !headerVal) {
    bad('Faltan REDENLACE_QR_WEBHOOK_URL o REDENLACE_QR_WEBHOOK_VALUE');
    process.exit(1);
  }
  ok(`webhook: ${webhookUrl}`);
  info(`cabecera ${headerKey}: ${headerVal.length} caracteres (no se imprime)`);

  // ── Estado real del QR en ATC ──────────────────────────────────────────────
  head('2. Estado del QR en ATC');

  const svc  = await import('../src/services/bankQr/banks/redenlaceQrService.js');
  const info_ = await svc.getQRStatus(QR_ID);

  if (info_.status !== 'paid') {
    bad(`ATC reporta '${info_.status}'. Sin un QR pagado la segunda capa rechaza y la prueba no sirve.`);
    process.exit(1);
  }
  ok(`ATC confirma PAGADO · ${info_.payment.amount} ${info_.payment.currency} · ${info_.payment.senderName}`);

  const monto = Number(info_.payment.amount);

  // ── Preparar el depósito ───────────────────────────────────────────────────
  head('3. Depósito en staging');

  await mongoose.connect(uri);
  const User              = (await import('../src/models/User.js')).default;
  const WalletBOB         = (await import('../src/models/WalletBOB.js')).default;
  const WalletTransaction = (await import('../src/models/WalletTransaction.js')).default;

  const email = arg('email');
  const user  = email
    ? await User.findOne({ email })
    : await User.findOne({ legalEntity: 'SRL' }).sort({ createdAt: 1 });

  if (!user) { bad('No encontré un usuario SRL en staging. Pasá --email.'); await mongoose.disconnect(); process.exit(1); }
  ok(`usuario: ${user.email}`);

  const existente = await WalletTransaction.findOne({ 'bankQr.qrId': String(QR_ID) });
  if (existente) {
    bad(`Ya existe una WalletTransaction con ese qrId (${existente.wtxId}, status=${existente.status}).`);
    info('El guard de idempotencia la va a ignorar. Usá otro QR pagado o borrá esa fila.');
    await mongoose.disconnect();
    process.exit(1);
  }

  let wallet = await WalletBOB.findOne({ userId: user._id });
  if (!wallet) {
    info('el usuario no tiene WalletBOB; se crea en el commit');
  } else {
    ok(`saldo actual: ${wallet.balance} BOB`);
  }

  if (!COMMIT) {
    head('Ensayo — no se escribió nada');
    info(`Se crearía una WalletTransaction 'deposit' pending por ${monto} BOB`);
    info(`con bankQr.qrId = ${QR_ID} y bankId = 'redenlace'`);
    info(`y luego se dispararía el webhook contra ${webhookUrl}`);
    info('');
    info('Para ejecutarlo de verdad, agregá --commit');
    await mongoose.disconnect();
    return;
  }

  if (!wallet) wallet = await WalletBOB.create({ userId: user._id, balance: 0 });
  const saldoAntes = wallet.balance;

  const wtx = await WalletTransaction.create({
    walletId:      wallet._id,
    userId:        user._id,
    type:          'deposit',
    amount:        monto,
    balanceBefore: saldoAntes,
    balanceAfter:  saldoAntes,
    status:        'pending',
    currency:      'BOB',
    description:   'Prueba e2e Red Enlace',
    bankQr:        { bankId: 'redenlace', qrId: String(QR_ID) },
  });
  ok(`WalletTransaction creada: ${wtx.wtxId}`);

  // ── Disparar el webhook ────────────────────────────────────────────────────
  head('4. Webhook');

  const cuerpo = {
    detalleRespuesta:     'Transacción procesada correctamente',
    codigoRespuesta:      'SUCCESS',
    numeroReferencia:     String(QR_ID),
    monto,
    moneda:               info_.payment.currency,
    fechaHoraTransaccion: info_.payment.raw?.bancoOrigen?.fechaTransaccion ?? '',
    clienteOrigen:        info_.payment.raw?.clienteOrigen ?? {},
    bancoOrigen:          info_.payment.raw?.bancoOrigen ?? {},
  };

  // Primero SIN la cabecera: tiene que rechazar. Si acreditara acá, el control
  // de autenticidad no estaría haciendo nada y el endpoint sería público.
  info('4.1 sin cabecera de autenticación (debe rechazar)');
  await fetch(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
  });
  const tras1 = await WalletTransaction.findById(wtx._id);
  if (tras1.status !== 'pending') {
    bad(`¡ACREDITÓ SIN CABECERA! status=${tras1.status}. El endpoint estaría abierto.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  ok('rechazado: sigue pending');

  info('4.2 con la cabecera correcta (debe acreditar)');
  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', [headerKey]: headerVal },
    body:    JSON.stringify(cuerpo),
  });
  info(`respuesta: HTTP ${res.status} ${await res.text().catch(() => '')}`);

  // ── Resultado ──────────────────────────────────────────────────────────────
  head('5. Resultado');

  await new Promise((r) => setTimeout(r, 2000));   // la acreditación es asíncrona
  const final  = await WalletTransaction.findById(wtx._id);
  const wFinal = await WalletBOB.findById(wallet._id);

  info(`estado del depósito : ${final.status}`);
  info(`saldo               : ${saldoAntes} → ${wFinal.balance} BOB`);
  info(`bankQr.paidAt       : ${final.bankQr?.paidAt ?? '(sin sello)'}`);

  if (final.status === 'completed' && wFinal.balance === saldoAntes + monto) {
    ok('Camino completo verificado: cabecera, importe, confirmación con ATC y acreditación.');
  } else {
    bad('No acreditó. Revisá los logs de staging para ver el motivo del rechazo.');
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  bad(e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
