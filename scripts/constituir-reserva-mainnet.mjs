#!/usr/bin/env node
/**
 * constituir-reserva-mainnet.mjs — Pasos 4 a 8 de la instrucción 15.
 *
 * ⚠️ ESTE SCRIPT NO GENERA, NO RECIBE Y NO CUSTODIA LLAVES PRIVADAS.
 *
 * Recibe únicamente CLAVES PÚBLICAS. Construye la transacción sin firmar y la
 * imprime en formato XDR para que los tenedores la firmen fuera de línea. La
 * firma ocurre en el equipo de cada tenedor; acá sólo se arma y se envía lo ya
 * firmado.
 *
 * Si alguna vez alguien te pide pegar una clave que empieza con S, algo se hizo
 * mal: parar y revisar el procedimiento.
 *
 * ── Modos ────────────────────────────────────────────────────────────────────
 *
 *   --crear --reserva <G…> [--fondeo 6]
 *       Crea y fondea la cuenta de reserva desde el canal de comisiones. Es lo
 *       único que este script firma, y lo firma con una llave que YA está en la
 *       infraestructura de forma legítima.
 *
 *   --armar --reserva <G…> --a <G…> --b <G…> --c <G…>
 *       Imprime el XDR SIN FIRMAR del acto de constitución. Se lleva al equipo
 *       del tenedor de la maestra, se firma allí, y se vuelve con el XDR firmado.
 *
 *   --enviar <XDR firmado>
 *       Envía a la red un sobre ya firmado. No lo modifica.
 *
 *   --verificar --reserva <G…>
 *       Comprueba la configuración objetivo completa contra la cadena.
 *
 * ── Por qué un solo acto ─────────────────────────────────────────────────────
 *
 * La autorización se evalúa contra el estado PREVIO. La maestra, que todavía pesa
 * 1, alcanza para autorizar el acto entero —incluido el que la deja en 0—. Partirlo
 * abriría una ventana en la que la maestra ya no firma y aún no hay quórum: en esa
 * ventana la cuenta queda muerta, y es una cadena pública, sin reversión ni soporte.
 *
 * Verificado íntegramente en la red de prueba con `ensayo-multifirma-testnet.mjs`.
 */

import {
  Keypair, TransactionBuilder, Transaction, Operation, Asset, Networks, Horizon, BASE_FEE,
} from '@stellar/stellar-sdk';

const HORIZON = process.env.STELLAR_HORIZON_URL ?? 'https://horizon.stellar.org';
const RED     = Networks.PUBLIC;
const server  = new Horizon.Server(HORIZON);

const USDC_ISSUER = process.env.STELLAR_USDC_ISSUER
  ?? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const USDC = new Asset('USDC', USDC_ISSUER);

const args  = process.argv.slice(2);
const tiene = f => args.includes(f);
const valor = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const ok = s => console.log(`   ✓ ${s}`);
const no = s => console.log(`   ✗ ${s}`);

/** Rechaza cualquier cosa que parezca una llave privada. */
function exigirPublica(v, etiqueta) {
  if (!v) { console.error(`✗ Falta ${etiqueta}`); process.exit(1); }
  if (v.startsWith('S')) {
    console.error(`\n  ⛔ ${etiqueta} parece una CLAVE PRIVADA.`);
    console.error('     Este script no recibe llaves privadas. Se aborta sin hacer nada.');
    console.error('     Volvé al procedimiento: las privadas no salen del equipo del tenedor.\n');
    process.exit(1);
  }
  try { Keypair.fromPublicKey(v); }
  catch { console.error(`✗ ${etiqueta} no es una clave pública válida`); process.exit(1); }
  return v;
}

// ── Modo: crear y fondear ──────────────────────────────────────────────────────

if (tiene('--crear')) {
  const reserva = exigirPublica(valor('--reserva'), '--reserva');
  const fondeo  = valor('--fondeo') ?? '6';

  // El canal de comisiones, no la operativa: la operativa firma los pagos
  // automáticos y dejarla al mínimo los detendría.
  const secretoCanal = process.env.STELLAR_MASTER_SECRET;
  if (!secretoCanal) { console.error('✗ Falta STELLAR_MASTER_SECRET (canal de comisiones)'); process.exit(1); }
  const canal = Keypair.fromSecret(secretoCanal);

  console.log(`\n  Creando la reserva ${reserva.slice(0, 8)}… con ${fondeo} XLM`);
  console.log(`  Origen: canal de comisiones ${canal.publicKey().slice(0, 8)}…\n`);

  const existe = await fetch(`${HORIZON}/accounts/${reserva}`);
  if (existe.ok) { no('la cuenta YA existe en la red — no se vuelve a crear'); process.exit(1); }

  const cuenta = await server.loadAccount(canal.publicKey());
  const tx = new TransactionBuilder(cuenta, { fee: BASE_FEE, networkPassphrase: RED })
    .addOperation(Operation.createAccount({ destination: reserva, startingBalance: String(fondeo) }))
    .setTimeout(120).build();
  tx.sign(canal);

  const res = await server.submitTransaction(tx);
  ok(`cuenta creada · identificador ${res.hash}`);
  console.log('\n  Siguiente: --armar, y llevar el XDR al equipo del tenedor de la maestra.\n');
  process.exit(0);
}

// ── Modo: armar el acto de constitución, SIN firmar ────────────────────────────

if (tiene('--armar')) {
  const reserva = exigirPublica(valor('--reserva'), '--reserva');
  const A = exigirPublica(valor('--a'), '--a');
  const B = exigirPublica(valor('--b'), '--b');
  const C = exigirPublica(valor('--c'), '--c');

  const unicas = new Set([reserva, A, B, C]);
  if (unicas.size !== 4) { no('hay claves repetidas: cada llave debe ser distinta'); process.exit(1); }

  const cuenta = await server.loadAccount(reserva);
  const tb = new TransactionBuilder(cuenta, { fee: String(Number(BASE_FEE) * 5), networkPassphrase: RED });

  tb.addOperation(Operation.changeTrust({ asset: USDC }));
  for (const pub of [A, B, C]) {
    tb.addOperation(Operation.setOptions({ signer: { ed25519PublicKey: pub, weight: 1 } }));
  }
  tb.addOperation(Operation.setOptions({
    masterWeight: 0, lowThreshold: 2, medThreshold: 2, highThreshold: 2,
  }));

  // Ventana amplia: la ceremonia de firma fuera de línea lleva su tiempo.
  const tx = tb.setTimeout(21600).build();   // 6 horas: la ceremonia fuera de línea no debe correr contra el reloj

  console.log('\n  ══ Acto de constitución · SIN FIRMAR ══\n');
  console.log(`  Cuenta de reserva : ${reserva}`);
  console.log(`  Firmante A        : ${A}`);
  console.log(`  Firmante B        : ${B}`);
  console.log(`  Recuperación C    : ${C}`);
  console.log(`  Operaciones       : ${tx.operations.length}  (1 línea de confianza + 3 altas + 1 de umbrales)`);
  console.log(`  Vence             : ${new Date(Number(tx.timeBounds.maxTime) * 1000).toISOString()}`);
  console.log('\n  XDR a firmar fuera de línea con la llave MAESTRA de la reserva:\n');
  console.log(tx.toXDR());
  console.log('\n  Firmado el sobre, enviarlo con:  --enviar "<XDR firmado>"\n');
  process.exit(0);
}

// ── Modo: enviar un sobre ya firmado ───────────────────────────────────────────

if (tiene('--enviar')) {
  const xdr = valor('--enviar');
  if (!xdr) { console.error('✗ Falta el XDR firmado'); process.exit(1); }

  const tx = new Transaction(xdr, RED);
  console.log(`\n  Enviando · origen ${tx.source.slice(0, 8)}… · ${tx.operations.length} operaciones · ${tx.signatures.length} firma(s)\n`);

  try {
    const res = await server.submitTransaction(tx);
    ok(`aceptada · identificador ${res.hash}`);
    console.log(`\n  Verificable en:  ${HORIZON}/transactions/${res.hash}\n`);
  } catch (err) {
    const codigos = err?.response?.data?.extras?.result_codes;
    no(`rechazada · ${JSON.stringify(codigos ?? err.message)}`);
    if (codigos?.transaction === 'tx_bad_auth') {
      console.log('     Faltan firmas o no alcanzan el umbral.');
    }
    process.exit(1);
  }
  process.exit(0);
}

// ── Modo: verificar ────────────────────────────────────────────────────────────

if (tiene('--verificar')) {
  const reserva = exigirPublica(valor('--reserva'), '--reserva');
  const a = await (await fetch(`${HORIZON}/accounts/${reserva}`)).json();

  const pesos = Object.fromEntries(a.signers.map(s => [s.key, s.weight]));
  const adicionales = a.signers.filter(s => s.key !== reserva && s.weight === 1);

  console.log(`\n  Cuenta de reserva ${reserva}\n`);
  console.log(`     umbrales    bajo ${a.thresholds.low_threshold} · medio ${a.thresholds.med_threshold} · alto ${a.thresholds.high_threshold}`);
  for (const s of a.signers) console.log(`     firmante    ${s.key}  peso ${s.weight}`);
  const usdc = a.balances.find(b => b.asset_code === 'USDC');
  console.log(`     USDC        ${usdc ? usdc.balance : 'sin línea de confianza'}`);
  console.log('');

  const pruebas = [
    ['peso de la llave maestra en 0',      (pesos[reserva] ?? 0) === 0],
    ['tres firmantes adicionales, peso 1', adicionales.length === 3],
    ['umbral bajo en 2',                   a.thresholds.low_threshold === 2],
    ['umbral medio en 2',                  a.thresholds.med_threshold === 2],
    ['umbral alto en 2',                   a.thresholds.high_threshold === 2],
    ['línea de confianza USDC establecida', Boolean(usdc)],
  ];
  let mal = 0;
  for (const [q, bien] of pruebas) { bien ? ok(q) : (no(q), mal++); }
  console.log(mal === 0
    ? '\n  El esquema está constituido conforme al apdo. 2.5.2 del Informe Técnico.\n'
    : `\n  ${mal} comprobación(es) fallan: el esquema NO está bien constituido.\n`);
  process.exit(mal === 0 ? 0 : 1);
}

console.log(`
  Uso:
    --crear     --reserva <G…> [--fondeo 6]
    --armar     --reserva <G…> --a <G…> --b <G…> --c <G…>
    --enviar    "<XDR firmado>"
    --verificar --reserva <G…>

  Ninguno de los modos acepta claves privadas.
`);
