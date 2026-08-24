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
import { Transaction, Keypair, Networks } from '@stellar/stellar-sdk';

const argv = process.argv.slice(2);
// Bandera explícita para los sobres que SÍ deben mover fondos —las pruebas de
// firma del esquema 2 de 3—. Sin ella, un pago aborta: es lo correcto para el
// acto de constitución, que nunca debe mover fondos.
const pagoEsperado = argv.includes('--pago-esperado');
const archivo = argv.find(a => !a.startsWith('--'));
if (!archivo) {
  console.error('\n  Uso: node scripts/firmar-fuera-de-linea.mjs <archivo-con-el-XDR> [--pago-esperado]\n');
  process.exit(1);
}

// El archivo de evidencia trae texto explicativo además del sobre. Se busca la
// línea que sea XDR: larga, en base64, y que empiece como una transacción v1.
const crudo = readFileSync(archivo, 'utf8');

// El archivo de evidencia trae texto explicativo ademas del sobre. Se detecta por
// PARSEO, no por longitud: se prueba cada linea que parezca base64 y se toma la
// ultima que resulte ser una transaccion valida. Un umbral de caracteres deja
// afuera los sobres cortos, que es justo lo que paso al probarlo.
let xdr = null;
let tx = null;
for (const linea of crudo.split('\n')) {
  const cand = linea.trim();
  if (cand.length < 40 || !/^[A-Za-z0-9+/=]+$/.test(cand)) continue;
  try {
    const t = new Transaction(cand, Networks.PUBLIC);
    xdr = cand; tx = t;                       // se queda con la ultima valida
  } catch { /* no era un sobre */ }
}

if (!xdr) {
  console.error(`\n  x No se encontro ningun sobre XDR valido en ${archivo}\n`);
  process.exit(1);
}

// Firmantes que el propio sobre declara aceptar. En un esquema de firma múltiple
// el firmante NO es la cuenta de origen: es uno de los firmantes adicionales. Por
// eso el sobre lista las claves públicas esperadas, y el guard comprueba
// pertenencia a esa lista en vez de igualdad con el origen. Sin esta línea —el
// acto de constitución— se cae al criterio anterior: la llave debe ser el origen.
const lineaEsperados = crudo.split('\n').find(l => /Firmantes?\s+esperad[oa]s?\s*:/i.test(l));
const firmantesEsperados = lineaEsperados
  ? (lineaEsperados.match(/G[A-Z2-7]{55}/g) ?? [])
  : [];


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

// Fusión de cuenta y pagos por ruta jamás son esperados: destruyen la cuenta o
// mueven valor de formas difíciles de leer. Se abortan siempre, sin excepción.
const nuncaEsperadas = tx.operations.filter(o => ['accountMerge', 'pathPaymentStrictSend', 'pathPaymentStrictReceive'].includes(o.type));
if (nuncaEsperadas.length) {
  console.log('\n   ⛔ EL SOBRE CONTIENE UNA OPERACIÓN QUE NUNCA DEBE FIRMARSE (fusión de cuenta o pago por ruta).');
  console.log('      No firmes. Avisá antes de continuar.\n');
  process.exit(1);
}

// Un pago simple mueve fondos. Se permite SÓLO con la bandera explícita —las
// pruebas de firma—. Sin ella se aborta, protegiendo el acto de constitución.
const pagos = tx.operations.filter(o => o.type === 'payment');
if (pagos.length && !pagoEsperado) {
  console.log('\n   ⛔ EL SOBRE MUEVE FONDOS y no se pasó --pago-esperado.');
  console.log('      El acto de constitución NO debe mover fondos: si esto era la constitución,');
  console.log('      no firmes y avisá. Si es una prueba de firma, volvé a correr con --pago-esperado.\n');
  process.exit(1);
}
if (pagos.length && pagoEsperado) {
  console.log('\n   ⚠️  Este sobre mueve fondos (prueba de firma). Revisá el importe y el destino arriba.');
}
if (restan <= 0) {
  console.log('\n   ⚠️ El sobre está vencido: la red lo rechazaría. Pedí uno nuevo.\n');
  process.exit(1);
}

// ── Confirmación y firma ──────────────────────────────────────────────────────

/**
 * Lee una linea de la entrada estandar. Con `oculto`, no la muestra en pantalla.
 *
 * Dos cosas que costaron una corrida fallida cada una:
 *
 *   1. **Un solo mecanismo.** La primera version mezclaba `readline` con lectura
 *      en crudo: `rl.pause()` dejaba la entrada detenida y el segundo prompt no
 *      recibia nada.
 *   2. **Hay que guardar el sobrante.** La entrada puede llegar en una sola tanda
 *      —al pegar, o por tuberia— con las dos respuestas juntas. Si al cortar en el
 *      salto de linea se descarta el resto, la segunda lectura se queda esperando
 *      para siempre datos que ya habian llegado.
 */
let pendiente = '';

function leerLinea(prompt, { oculto = false } = {}) {
  return new Promise(resolve => {
    process.stdout.write(prompt);

    // Si el sobrante ya contiene una linea entera, no hace falta tocar la entrada.
    const corte = pendiente.indexOf('\n');
    if (corte >= 0) {
      const linea = pendiente.slice(0, corte).replace(/\r$/, '');
      pendiente = pendiente.slice(corte + 1);
      process.stdout.write('\n');
      return resolve(linea);
    }

    const stdin   = process.stdin;
    const enCrudo = oculto && stdin.isTTY;
    const eraRaw  = Boolean(stdin.isRaw);
    if (enCrudo) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let valor = pendiente;
    pendiente = '';

    const terminar = resto => {
      pendiente = resto;
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      if (enCrudo) stdin.setRawMode(eraRaw);
      stdin.pause();
      process.stdout.write('\n');
    };

    const onData = trozo => {
      for (let i = 0; i < trozo.length; i++) {
        const c = trozo[i];
        if (c === '\n' || c === '\r') {
          terminar(trozo.slice(i + 1));
          return resolve(valor);
        }
        if (c === '\u0003') { terminar(''); console.log('  cancelado'); process.exit(1); }
        if (c === '\u0004') { terminar(''); return resolve(valor); }
        if (c === '\u007f' || c === '\b') { valor = valor.slice(0, -1); continue; }
        valor += c;
      }
    };

    const onEnd = () => { terminar(''); resolve(valor); };

    stdin.on('data', onData);
    stdin.on('end', onEnd);
  });
}

const conf = (await leerLinea('\n   Coincide con lo que esperabas? Escribi FIRMAR para continuar: ')).trim();
if (conf !== 'FIRMAR') {
  console.log('\n   No se firmo nada.\n');
  process.exit(1);
}

const secreta = (await leerLinea('   Clave secreta (no se muestra ni se guarda): ', { oculto: true })).trim();

if (!secreta.startsWith('S')) {
  console.error('\n   ✗ Una clave secreta empieza con S. Revisá lo que copiaste.\n');
  process.exit(1);
}

let kp;
try { kp = Keypair.fromSecret(secreta); }
catch { console.error('\n   ✗ La clave secreta no es válida. Revisá la transcripción del papel.\n'); process.exit(1); }

const aceptadas = firmantesEsperados.length ? firmantesEsperados : [tx.source];
if (!aceptadas.includes(kp.publicKey())) {
  console.error('\n   ✗ Esa llave NO es una de las que este sobre espera.');
  console.error(`      El sobre acepta : ${aceptadas.join(', ')}`);
  console.error(`      La llave es de  : ${kp.publicKey()}`);
  console.error('      No se firmó nada.\n');
  process.exit(1);
}

// En un sobre de dos firmas, la primera llave ya dejó su firma. Avisar si esta
// llave ya firmó, para no gastar el turno del segundo firmante por error.
if (tx.signatures.some(s => s.hint().equals(kp.signatureHint()))) {
  console.error('\n   ⚠️ Esta llave YA firmó este sobre. No se agrega una firma repetida.');
  console.error('      Si falta la otra firma, que la ponga el otro firmante.\n');
  process.exit(1);
}

tx.sign(kp);

console.log('\n   ✓ Firmado por ' + kp.publicKey());
console.log('\n  ══════════════════════════════════════════════════════════════════');
console.log('   SOBRE FIRMADO — esto sí se puede compartir, no contiene la secreta');
console.log('  ══════════════════════════════════════════════════════════════════\n');
console.log(tx.toXDR());
console.log('\n   Guardá el papel. Volvé a conectar la red recién ahora.\n');
