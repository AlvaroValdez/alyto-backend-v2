#!/usr/bin/env node
/**
 * firmar-fuera-de-linea.mjs — Ceremonia de firma, en la máquina sin red.
 *
 * Se ejecuta en el equipo del tenedor de la llave. Lee el sobre sin firmar, MUESTRA
 * lo que hace antes de firmarlo, pide confirmación, y recién entonces firma.
 *
 * Tres cuidados que justifican que esto sea un script y no un `node -e`:
 *
 *   1. **La clave secreta se pide por entrada oculta, nunca como argumento.** Un
 *      argumento queda en el historial del shell y es visible en la lista de
 *      procesos para cualquier otro usuario de la máquina. Acá no toca ninguna
 *      de las dos cosas.
 *   2. **Muestra el contenido antes de firmar.** Firmar a ciegas un sobre que
 *      lleva la llave maestra a peso 0 es exactamente lo que no hay que hacer.
 *   3. **No escribe la secreta en ningún lado**: ni archivo, ni variable de
 *      entorno, ni registro. Vive en memoria el tiempo de la firma.
 *
 *   node scripts/firmar-fuera-de-linea.mjs <archivo-con-el-XDR>
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Transaction, Keypair, Networks } from '@stellar/stellar-sdk';

const archivo = process.argv[2];
if (!archivo) {
  console.error('\n  Uso: node scripts/firmar-fuera-de-linea.mjs <archivo-con-el-XDR>\n');
  process.exit(1);
}

// El archivo de evidencia trae texto explicativo además del sobre. Se busca la
// línea que sea XDR: larga, en base64, y que empiece como una transacción v1.
const crudo = readFileSync(archivo, 'utf8');
const xdr = crudo.split('\n')
  .map(l => l.trim())
  .filter(l => l.length > 200 && /^[A-Za-z0-9+/=]+$/.test(l))
  .pop();

if (!xdr) {
  console.error(`\n  ✗ No se encontró ningún sobre XDR en ${archivo}\n`);
  process.exit(1);
}

let tx;
try { tx = new Transaction(xdr, Networks.PUBLIC); }
catch (err) { console.error(`\n  ✗ El sobre no es una transacción válida: ${err.message}\n`); process.exit(1); }

// ── Mostrar qué se va a firmar ────────────────────────────────────────────────

const resumen = op => {
  if (op.type === 'changeTrust') return `línea de confianza  ${op.line.code} del emisor ${op.line.issuer.slice(0, 8)}…`;
  if (op.type === 'setOptions') {
    if (op.signer) return `ALTA DE FIRMANTE    ${op.signer.ed25519PublicKey}  peso ${op.signer.weight}`;
    const p = [];
    if (op.masterWeight !== undefined)  p.push(`peso de la maestra → ${op.masterWeight}`);
    if (op.lowThreshold !== undefined)  p.push(`umbral bajo → ${op.lowThreshold}`);
    if (op.medThreshold !== undefined)  p.push(`umbral medio → ${op.medThreshold}`);
    if (op.highThreshold !== undefined) p.push(`umbral alto → ${op.highThreshold}`);
    return `UMBRALES            ${p.join(' · ')}`;
  }
  if (op.type === 'payment') return `⚠️ PAGO             ${op.amount} ${op.asset.code ?? 'XLM'} → ${op.destination}`;
  if (op.type === 'accountMerge') return `⛔ FUSIÓN DE CUENTA → ${op.destination}`;
  return `⚠️ ${op.type} — operación no esperada en este acto`;
};

const vence = new Date(Number(tx.timeBounds?.maxTime ?? 0) * 1000);
const restan = (vence - Date.now()) / 60000;

console.log('\n  ══════════════════════════════════════════════════════════════════');
console.log('   ESTO ES LO QUE VAS A FIRMAR. Leelo antes de continuar.');
console.log('  ══════════════════════════════════════════════════════════════════\n');
console.log(`   Red             ${tx.networkPassphrase === Networks.PUBLIC ? 'PRINCIPAL (dinero real)' : '⚠️ ' + tx.networkPassphrase}`);
console.log(`   Cuenta de origen ${tx.source}`);
console.log(`   Firmas actuales  ${tx.signatures.length}`);
console.log(`   Vence            ${vence.toISOString()}  ${restan > 0 ? `(en ${Math.round(restan)} min)` : '⚠️ YA VENCIÓ'}`);
console.log(`\n   ${tx.operations.length} operaciones:\n`);
tx.operations.forEach((op, i) => console.log(`     ${i + 1}. ${resumen(op)}`));

const peligrosas = tx.operations.filter(o => ['payment', 'accountMerge', 'pathPaymentStrictSend', 'pathPaymentStrictReceive'].includes(o.type));
if (peligrosas.length) {
  console.log('\n   ⛔ EL SOBRE MUEVE FONDOS. El acto de constitución NO debe hacerlo.');
  console.log('      No firmes. Avisá antes de continuar.\n');
  process.exit(1);
}
if (restan <= 0) {
  console.log('\n   ⚠️ El sobre está vencido: la red lo rechazaría. Pedí uno nuevo.\n');
  process.exit(1);
}

// ── Confirmación y firma ──────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });
const preguntar = q => new Promise(r => rl.question(q, r));

/** Lee sin mostrar en pantalla. Evita que la secreta quede a la vista. */
function preguntarOculto(q) {
  return new Promise(resolve => {
    process.stdout.write(q);
    const stdin = process.stdin;
    const eraRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let valor = '';
    const onData = ch => {
      const c = ch.toString('utf8');
      if (c === '\r' || c === '\n' || c === '') {
        if (stdin.isTTY) stdin.setRawMode(eraRaw);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(valor);
      } else if (c === '') {           // Ctrl-C
        process.stdout.write('\n  cancelado\n');
        process.exit(1);
      } else if (c === '' || c === '\b') {
        valor = valor.slice(0, -1);
      } else {
        valor += c;
      }
    };
    stdin.on('data', onData);
  });
}

const conf = (await preguntar('\n   ¿Coincide con lo que esperabas? Escribí FIRMAR para continuar: ')).trim();
if (conf !== 'FIRMAR') {
  console.log('\n   No se firmó nada.\n');
  rl.close();
  process.exit(1);
}

rl.pause();
const secreta = (await preguntarOculto('   Clave secreta (no se muestra ni se guarda): ')).trim();
rl.close();

if (!secreta.startsWith('S')) {
  console.error('\n   ✗ Una clave secreta empieza con S. Revisá lo que copiaste.\n');
  process.exit(1);
}

let kp;
try { kp = Keypair.fromSecret(secreta); }
catch { console.error('\n   ✗ La clave secreta no es válida. Revisá la transcripción del papel.\n'); process.exit(1); }

if (kp.publicKey() !== tx.source) {
  console.error('\n   ✗ Esa llave NO corresponde a la cuenta de origen del sobre.');
  console.error(`      El sobre espera : ${tx.source}`);
  console.error(`      La llave es de  : ${kp.publicKey()}`);
  console.error('      No se firmó nada.\n');
  process.exit(1);
}

tx.sign(kp);

console.log('\n   ✓ Firmado por ' + kp.publicKey());
console.log('\n  ══════════════════════════════════════════════════════════════════');
console.log('   SOBRE FIRMADO — esto sí se puede compartir, no contiene la secreta');
console.log('  ══════════════════════════════════════════════════════════════════\n');
console.log(tx.toXDR());
console.log('\n   Guardá el papel. Volvé a conectar la red recién ahora.\n');
