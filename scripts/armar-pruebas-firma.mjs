#!/usr/bin/env node
/**
 * armar-pruebas-firma.mjs — Tarea 3 de la instrucción 17.
 *
 * Arma los TRES actos de prueba sin firmar, en una sola tanda, para que la
 * ceremonia fuera de línea ocurra una vez y no tres.
 *
 * ── Por qué los números de secuencia son los que son ─────────────────────────
 *
 * Una transacción rechazada por firmas insuficientes (`tx_bad_auth`) **no consume
 * el número de secuencia**: la red la descarta antes de incorporarla. Una aceptada
 * sí lo consume. De ahí el reparto:
 *
 *   prueba 1  (A + B, se acepta)     → secuencia N+1, que consume
 *   prueba 2  (solo A, se rechaza)   → secuencia N+2, que NO consume
 *   prueba 3  (B + C, se acepta)     → secuencia N+2, la misma que dejó libre
 *
 * Si a la prueba 2 se le diera una secuencia ya usada, la red la rechazaría con
 * `tx_bad_seq` en vez de `tx_bad_auth`, y la evidencia 4 dejaría de probar lo que
 * tiene que probar: que una firma no alcanza. El motivo del rechazo ES la prueba.
 *
 * **Enviarlas en orden.** Fuera de orden, ninguna funciona.
 *
 *   node scripts/armar-pruebas-firma.mjs
 */

import { TransactionBuilder, Operation, Asset, Networks, Account, BASE_FEE, Memo } from '@stellar/stellar-sdk';

const HORIZON = process.env.STELLAR_HORIZON_URL ?? 'https://horizon.stellar.org';
const RED     = Networks.PUBLIC;
const USDC    = new Asset('USDC', process.env.STELLAR_USDC_ISSUER
  ?? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');

const fria      = process.env.STELLAR_SRL_COLD_PUBLIC_KEY;
const operativa = process.env.STELLAR_SRL_PUBLIC_KEY;
if (!fria || !operativa) { console.error('✗ Faltan las claves públicas de las dos cuentas'); process.exit(1); }

// Importe simbólico: la prueba acredita el control, no mueve respaldo.
const MONTO = '1';

const cuenta = await (await fetch(`${HORIZON}/accounts/${fria}`)).json();
const seq = BigInt(cuenta.sequence);

const armar = (secuencia, etiqueta) => {
  const tx = new TransactionBuilder(new Account(fria, secuencia.toString()), {
    fee: BASE_FEE, networkPassphrase: RED,
  })
    .addOperation(Operation.payment({ destination: operativa, asset: USDC, amount: MONTO }))
    .addMemo(Memo.text(etiqueta))
    .setTimeout(43200)          // 12 horas
    .build();
  return tx.toXDR();
};

const PRUEBAS = [
  { n: 1, firman: 'A + B',  claves: 'A (Álvaro) y B (David)', espera: 'ACEPTADA',  ev: 'evidencia 3',
    seq: seq,     memo: 'prueba-2-firmas' },
  { n: 2, firman: 'solo A', claves: 'únicamente A (Álvaro)',  espera: 'RECHAZADA', ev: 'evidencia 4',
    seq: seq + 1n, memo: 'prueba-1-firma' },
  { n: 3, firman: 'B + C',  claves: 'B (David) y C (custodia)', espera: 'ACEPTADA', ev: 'recuperación',
    seq: seq + 1n, memo: 'prueba-recuperacion' },
];

console.log('');
console.log('  ══ Tres actos de prueba · SIN FIRMAR ══');
console.log('');
console.log(`  Origen  : ${fria}   (la reserva)`);
console.log(`  Destino : ${operativa}   (la operativa)`);
console.log(`  Importe : ${MONTO} USDC en cada una — simbólico`);
console.log(`  Vencen  : en 12 horas`);
console.log('');
console.log('  ⚠️ ENVIAR EN ORDEN 1 → 2 → 3. Fuera de orden ninguna funciona.');
console.log('');

for (const p of PRUEBAS) {
  console.log(`  ── Prueba ${p.n} · firman ${p.firman} · se espera ${p.espera} · ${p.ev} ──`);
  console.log(`     Firmar con: ${p.claves}`);
  console.log('');
  console.log(armar(p.seq, p.memo));
  console.log('');
}

console.log('  La prueba 2 debe fallar con `tx_bad_auth`. Ese rechazo ES la evidencia:');
console.log('  acredita que una sola llave no mueve el respaldo.');
console.log('');
