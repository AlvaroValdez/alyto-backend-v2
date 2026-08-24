#!/usr/bin/env node
/**
 * trasladar-respaldo-reserva.mjs — Tarea 2 de la instrucción 17.
 *
 * Traslada USDC de la cuenta operativa a la cuenta de reserva bajo firma múltiple.
 * Va en este sentido y no en el otro: la vuelta —reposición de la operativa desde
 * la reserva— exige dos firmas y es un acto manual, y este script no la hace ni
 * podría hacerla.
 *
 * Firma la operativa, cuya llave está en la infraestructura de forma legítima.
 *
 * ── Criterio del dimensionamiento ────────────────────────────────────────────
 *
 * En la operativa queda la porción MENOR del respaldo: la suficiente para liquidar
 * sin pedir reposiciones a cada rato, y no más. Dos extremos que se evitan:
 *
 *   · Saldo muy bajo  → reposiciones constantes, y cada una es un acto manual de
 *                       dos personas.
 *   · Saldo muy alto  → sube la exposición a la actuación unilateral sin ninguna
 *                       necesidad, que es justo lo que el esquema viene a acotar.
 *
 * El monto es OPERATIVO. No se declara ante ASFI: el expediente consigna la
 * propiedad que se sostiene siempre, no el saldo de un instante (apdo. 2.8.3).
 *
 * ── Uso ──────────────────────────────────────────────────────────────────────
 *
 *   node scripts/trasladar-respaldo-reserva.mjs --monto 380            (simula)
 *   node scripts/trasladar-respaldo-reserva.mjs --monto 380 --commit   (ejecuta)
 */

import { Keypair, TransactionBuilder, Operation, Asset, Networks, Horizon, BASE_FEE } from '@stellar/stellar-sdk';

const HORIZON = process.env.STELLAR_HORIZON_URL ?? 'https://horizon.stellar.org';
const RED     = Networks.PUBLIC;
const server  = new Horizon.Server(HORIZON);
const USDC    = new Asset('USDC', process.env.STELLAR_USDC_ISSUER
  ?? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');

const args   = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const monto  = Number(args[args.indexOf('--monto') + 1]);

if (!Number.isFinite(monto) || monto <= 0) { console.error('✗ Falta --monto'); process.exit(1); }

const secretoOperativa = process.env.STELLAR_SRL_SECRET_KEY;
const fria = process.env.STELLAR_SRL_COLD_PUBLIC_KEY;
if (!secretoOperativa) { console.error('✗ Falta STELLAR_SRL_SECRET_KEY'); process.exit(1); }
if (!fria) { console.error('✗ Falta STELLAR_SRL_COLD_PUBLIC_KEY — agregarla ANTES de trasladar'); process.exit(1); }

const operativa = Keypair.fromSecret(secretoOperativa);

const saldo = async pub => {
  const a = await (await fetch(`${HORIZON}/accounts/${pub}`)).json();
  const b = a.balances.find(x => x.asset_code === 'USDC');
  return { usdc: b ? Number(b.balance) : null, cuenta: a };
};

const antesOp  = await saldo(operativa.publicKey());
const antesFr  = await saldo(fria);

console.log('');
console.log(`  operativa ${operativa.publicKey().slice(0, 8)}…  ${antesOp.usdc} USDC`);
console.log(`  reserva   ${fria.slice(0, 8)}…  ${antesFr.usdc === null ? 'SIN línea de confianza' : antesFr.usdc + ' USDC'}`);
console.log('');

// ── Guardas ───────────────────────────────────────────────────────────────────

let mal = 0;
const no = s => { console.log(`   ✗ ${s}`); mal++; };
const ok = s => console.log(`   ✓ ${s}`);

if (antesFr.usdc === null) no('la reserva no tiene línea de confianza USDC: el pago sería rechazado');
else ok('la reserva acepta USDC');

// La reserva tiene que estar realmente bajo multifirma. Trasladar el respaldo a
// una cuenta de firma simple sería peor que no trasladarlo.
const fr = antesFr.cuenta;
const maestraFria = fr.signers?.find(s => s.key === fria)?.weight ?? 0;
const adicionales = (fr.signers ?? []).filter(s => s.key !== fria && s.weight > 0).length;
if (maestraFria === 0 && fr.thresholds?.med_threshold >= 2 && adicionales >= 3) {
  ok(`la reserva está bajo multifirma (maestra 0 · umbral ${fr.thresholds.med_threshold} · ${adicionales} firmantes)`);
} else {
  no('la reserva NO está bajo multifirma — no trasladar');
}

const quedaria = Number((antesOp.usdc - monto).toFixed(7));
if (quedaria < 0) no(`la operativa no tiene ${monto} USDC`);
else ok(`la operativa quedaría con ${quedaria} USDC`);

// El umbral de alerta de saldo bajo: quedar por debajo dispararía un aviso que no
// corresponde a un problema real.
const umbral = Number(process.env.USDC_LOW_BALANCE_THRESHOLD ?? 200);
if (quedaria < umbral) no(`quedaría por debajo del umbral de alerta (${umbral}) y dispararía un aviso`);
else ok(`por encima del umbral de alerta (${umbral})`);

// La porción menor queda en la operativa. Es el criterio, no una preferencia.
const porcion = quedaria / antesOp.usdc;
if (porcion >= 0.5) no(`en la operativa quedaría el ${(porcion * 100).toFixed(1)}% — debe quedar la porción MENOR`);
else ok(`en la operativa queda el ${(porcion * 100).toFixed(1)}% · en la reserva el ${((1 - porcion) * 100).toFixed(1)}%`);

if (mal) { console.log(`\n  ${mal} guarda(s) impiden el traslado.\n`); process.exit(1); }

if (!COMMIT) {
  console.log('\n  Simulación. Para ejecutar, agregar --commit\n');
  process.exit(0);
}

// ── Ejecución ─────────────────────────────────────────────────────────────────

const cuenta = await server.loadAccount(operativa.publicKey());
const tx = new TransactionBuilder(cuenta, { fee: BASE_FEE, networkPassphrase: RED })
  .addOperation(Operation.payment({ destination: fria, asset: USDC, amount: monto.toFixed(7) }))
  .addMemo((await import('@stellar/stellar-sdk')).Memo.text('respaldo-a-reserva'))
  .setTimeout(120).build();
tx.sign(operativa);

const res = await server.submitTransaction(tx);
console.log(`\n   ✓ trasladados ${monto} USDC · identificador ${res.hash}`);

const despOp = await saldo(operativa.publicKey());
const despFr = await saldo(fria);
console.log('');
console.log(`   operativa : ${antesOp.usdc}  →  ${despOp.usdc}`);
console.log(`   reserva   : ${antesFr.usdc}  →  ${despFr.usdc}`);
console.log(`   total     : ${Number((despOp.usdc + despFr.usdc).toFixed(7))}  (antes ${Number((antesOp.usdc + antesFr.usdc).toFixed(7))})`);
console.log('');
