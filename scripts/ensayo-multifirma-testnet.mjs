#!/usr/bin/env node
/**
 * ensayo-multifirma-testnet.mjs — Paso 1 de la instrucción 15.
 *
 * Reproduce ÍNTEGRAMENTE el procedimiento de constitución del esquema 2 de 3
 * sobre cuentas de prueba, antes de tocar la red principal.
 *
 * Por qué no es opcional: la transacción de constitución lleva el peso de la llave
 * maestra a 0 en el mismo acto en que sube los umbrales. Si los umbrales quedan por
 * encima del peso sumado de los firmantes que se agregan, **nadie puede volver a
 * firmar** y la cuenta queda inoperable de forma irreversible. No hay soporte, no
 * hay reversión y no hay quien la rescate: es una cadena pública.
 *
 * El ensayo verifica las cuatro propiedades que el expediente afirma:
 *
 *   1. Dos firmas mueven el respaldo.
 *   2. Una firma NO alcanza — la red rechaza.
 *   3. La vía de recuperación opera: B + C mueven sin A.
 *   4. Una sola llave NO puede desmontar el control (umbral alto en 2).
 *
 * Las llaves de este ensayo son desechables y se generan acá. **Las de la red
 * principal las generan sus tenedores fuera de esta infraestructura**: este script
 * no toca, no recibe y no persiste ninguna llave real.
 *
 *   node scripts/ensayo-multifirma-testnet.mjs
 */

import {
  Keypair, TransactionBuilder, Operation, Asset, Networks, Horizon, BASE_FEE,
} from '@stellar/stellar-sdk';

const HORIZON = 'https://horizon-testnet.stellar.org';
const RED     = Networks.TESTNET;
const server  = new Horizon.Server(HORIZON);

const paso = n => console.log(`\n  ══ ${n} ══`);
const ok   = s => console.log(`   ✓ ${s}`);
const no   = s => console.log(`   ✗ ${s}`);
const dato = (k, v) => console.log(`     ${k.padEnd(22)} ${v}`);

let fallos = 0;

async function fondear(kp, etiqueta) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot falló para ${etiqueta}: ${r.status}`);
  ok(`${etiqueta} fondeada — ${kp.publicKey().slice(0, 8)}…`);
}

/** Construye, firma con las llaves dadas y envía. Devuelve {ok, hash, codigo}. */
async function enviar(fuenteKp, construir, firmantes, { esperaFallo = false } = {}) {
  const cuenta = await server.loadAccount(fuenteKp.publicKey());
  const tb = new TransactionBuilder(cuenta, { fee: BASE_FEE, networkPassphrase: RED });
  construir(tb);
  const tx = tb.setTimeout(60).build();
  for (const kp of firmantes) tx.sign(kp);

  try {
    const res = await server.submitTransaction(tx);
    return { ok: true, hash: res.hash };
  } catch (err) {
    const datos = err?.response?.data?.extras ?? {};
    const codigo = datos.result_codes?.transaction ?? err.message;
    if (!esperaFallo) console.error('     detalle:', JSON.stringify(datos.result_codes ?? err.message));
    return { ok: false, codigo };
  }
}

// ── Preparación ────────────────────────────────────────────────────────────────

console.log('\n  Ensayo del esquema 2 de 3 — red de prueba');
console.log(`  ${HORIZON}\n`);

paso('preparación · cuentas y llaves desechables');

const emisor   = Keypair.random();   // hace de emisor del activo estable
const operativa = Keypair.random();  // hace de cuenta caliente: crea y fondea la reserva
const reserva  = Keypair.random();   // la que quedará bajo 2 de 3

const A = Keypair.random();          // firmante operativo
const B = Keypair.random();          // firmante operativo
const C = Keypair.random();          // llave de recuperación

await fondear(emisor, 'emisora');
await fondear(operativa, 'operativa');

const USDC = new Asset('USDC', emisor.publicKey());

// La operativa necesita su propia línea de confianza para poder RECIBIR el activo.
// En la red principal ya la tiene; acá hay que establecerla, o los movimientos de
// prueba fallan con `op_no_trust` después de haber autenticado correctamente —que
// es justamente lo que ocurrió en la primera corrida de este ensayo.
let r = await enviar(operativa, tb => tb.addOperation(Operation.changeTrust({ asset: USDC })), [operativa]);
r.ok ? ok('operativa con línea de confianza USDC') : no(`línea de confianza operativa: ${r.codigo}`);

// La reserva se crea DESDE la operativa, igual que en la red principal.
// (2 base + 1 línea de confianza + 3 firmantes) × 0,5 = 3,0 XLM de mínimo.
// Se fondea con 6 para dejar margen de comisiones.
r = await enviar(operativa, tb => tb.addOperation(Operation.createAccount({
  destination: reserva.publicKey(), startingBalance: '6',
})), [operativa]);
r.ok ? ok('reserva creada con 6 XLM') : no(`no se pudo crear la reserva: ${r.codigo}`);

// ── Constitución ───────────────────────────────────────────────────────────────
//
// UN SOLO ACTO, y esta es la forma exacta que se ejecuta en la red principal.
//
// Tres razones para que línea de confianza, firmantes y umbrales viajen juntos:
//
//   1. Partirlo deja una ventana en la que la maestra ya no firma pero todavía no
//      hay quórum. En esa ventana la cuenta está muerta.
//   2. La autorización se evalúa contra el estado PREVIO a la transacción, de modo
//      que la maestra —que aún pesa 1— alcanza para autorizar el acto entero,
//      incluido el que la deja en 0. Las operaciones se aplican en orden: la línea
//      de confianza se establece mientras la maestra todavía puede.
//   3. Una sola ceremonia de firma fuera de línea en vez de tres.

paso('constitución · un solo acto: línea de confianza + firmantes + umbrales');

r = await enviar(reserva, tb => {
  tb.addOperation(Operation.changeTrust({ asset: USDC }));
  for (const kp of [A, B, C]) {
    tb.addOperation(Operation.setOptions({
      signer: { ed25519PublicKey: kp.publicKey(), weight: 1 },
    }));
  }
  tb.addOperation(Operation.setOptions({
    masterWeight:    0,   // ← el punto crítico: la maestra deja de firmar sola
    lowThreshold:    2,
    medThreshold:    2,
    highThreshold:   2,   // ← protege la propia modificación de firmantes
  }));
}, [reserva]);

if (r.ok) { ok('esquema constituido'); dato('identificador', r.hash); }
else { no(`constitución falló: ${r.codigo}`); fallos++; }

// ── Verificación de la configuración ───────────────────────────────────────────

paso('verificación · configuración en la cadena');

const cuenta = await server.loadAccount(reserva.publicKey());
const pesos  = Object.fromEntries(cuenta.signers.map(s => [s.key, s.weight]));

dato('umbrales', JSON.stringify(cuenta.thresholds));
dato('firmantes', cuenta.signers.length);
for (const s of cuenta.signers) dato(`  ${s.key.slice(0, 8)}…`, `peso ${s.weight}`);

const comprobaciones = [
  ['peso de la llave maestra en 0', pesos[reserva.publicKey()] === 0 || pesos[reserva.publicKey()] === undefined],
  ['tres firmantes con peso 1',     [A, B, C].every(k => pesos[k.publicKey()] === 1)],
  ['umbral bajo en 2',              cuenta.thresholds.low_threshold === 2],
  ['umbral medio en 2',             cuenta.thresholds.med_threshold === 2],
  ['umbral alto en 2',              cuenta.thresholds.high_threshold === 2],
];
for (const [q, bien] of comprobaciones) { bien ? ok(q) : (no(q), fallos++); }

// El respaldo se traslada DESPUÉS de constituido el esquema. Al revés, el respaldo
// pasaría un rato en una cuenta de firma simple, que es lo que se quiere evitar.
paso('traslado del respaldo · después de constituir, nunca antes');
r = await enviar(emisor, tb => tb.addOperation(Operation.payment({
  destination: reserva.publicKey(), asset: USDC, amount: '500',
})), [emisor]);
r.ok ? ok('500 USDC trasladados a la reserva ya protegida') : (no(`traslado: ${r.codigo}`), fallos++);

// ── Las cuatro propiedades ─────────────────────────────────────────────────────

const pagoChico = tb => tb.addOperation(Operation.payment({
  destination: operativa.publicKey(), asset: USDC, amount: '1',
}));

paso('propiedad 1 · dos firmas mueven el respaldo');
r = await enviar(reserva, pagoChico, [A, B]);
if (r.ok) { ok('A + B → aceptada'); dato('identificador', r.hash); }
else { no(`A + B rechazada: ${r.codigo}`); fallos++; }

paso('propiedad 2 · una firma NO alcanza');
r = await enviar(reserva, pagoChico, [A], { esperaFallo: true });
if (!r.ok && String(r.codigo).includes('bad_auth')) ok(`solo A → rechazada por la red · ${r.codigo}`);
else if (r.ok) { no('solo A fue ACEPTADA — el control no muerde'); fallos++; }
else { no(`rechazada, pero por otro motivo: ${r.codigo}`); fallos++; }

paso('propiedad 3 · vía de recuperación, sin el firmante A');
r = await enviar(reserva, pagoChico, [B, C]);
if (r.ok) { ok('B + C → aceptada'); dato('identificador', r.hash); }
else { no(`B + C rechazada: ${r.codigo}`); fallos++; }

paso('propiedad 4 · una sola llave NO puede desmontar el control');
const intruso = Keypair.random();
r = await enviar(reserva, tb => tb.addOperation(Operation.setOptions({
  signer: { ed25519PublicKey: intruso.publicKey(), weight: 1 },
})), [A], { esperaFallo: true });
if (!r.ok && String(r.codigo).includes('bad_auth')) ok(`alta de firmante con una sola llave → rechazada · ${r.codigo}`);
else if (r.ok) { no('una sola llave AGREGÓ un firmante — el umbral alto no protege'); fallos++; }
else { no(`rechazada, pero por otro motivo: ${r.codigo}`); fallos++; }

// ── Cierre ─────────────────────────────────────────────────────────────────────

paso('resultado');
if (fallos === 0) {
  ok('las cuatro propiedades se verifican. El procedimiento es reproducible en la red principal.');
  console.log('\n  Orden exacto que funcionó, y que debe replicarse sin improvisar:');
  console.log('    1. crear y fondear la cuenta de reserva con 6 XLM, desde una cuenta de la entidad');
  console.log('    2. UN SOLO acto firmado por la maestra, con estas operaciones en este orden:');
  console.log('         changeTrust del activo');
  console.log('         setOptions × 3 — un firmante peso 1 cada uno');
  console.log('         setOptions — maestra a 0 y los tres umbrales en 2');
  console.log('    3. VERIFICAR la configuración en la cadena antes de seguir');
  console.log('    4. recién entonces trasladar el respaldo');
  console.log('    5. acreditar las cuatro propiedades: 2 firmas, 1 firma, recuperación, umbral alto');
  console.log('\n  El paso 4 va DESPUÉS del 3 a propósito: al revés, el respaldo pasaría un');
  console.log('  rato en una cuenta de firma simple, que es justamente lo que se evita.');
} else {
  no(`${fallos} comprobación(es) fallaron. NO ejecutar en la red principal.`);
}
console.log('');
process.exit(fallos === 0 ? 0 : 1);
