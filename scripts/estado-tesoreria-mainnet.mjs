#!/usr/bin/env node
/**
 * estado-tesoreria-mainnet.mjs — Pasos 0 y 3 de la instrucción 15.
 *
 * Captura el estado de las cuentas de la entidad en la red principal y calcula el
 * margen de XLM disponible. Es de sólo lectura: consulta el libro público y no
 * firma nada.
 *
 * Produce la EVIDENCIA 1 del apdo. 2.5.2 —el estado previo a la constitución— y
 * responde la verificación 0.1: si el margen alcanza para crear la cuenta de
 * reserva. Sin margen, la operación falla a mitad de camino.
 *
 * El mínimo de una cuenta es (2 + subentradas) × 0,5 XLM. Cada firmante adicional
 * y cada línea de confianza es una subentrada, así que una cuenta 2-de-3 con una
 * línea de confianza necesita (2 + 1 + 3) × 0,5 = 3,0 XLM inmovilizados.
 */

const HORIZON = process.env.STELLAR_HORIZON_URL ?? 'https://horizon.stellar.org';
const BASE_RESERVE = 0.5;

// Mínimo de la futura cuenta de reserva: 2 base + 1 línea de confianza + 3 firmantes.
const MINIMO_RESERVA = (2 + 1 + 3) * BASE_RESERVE;
const RECOMENDADO_RESERVA = 6;   // el valor con que se ensayó en la red de prueba

const CUENTAS = [
  ['operativa (caliente)', process.env.STELLAR_SRL_PUBLIC_KEY,      'firma simple · la mueve el sistema'],
  ['reserva (fría)',       process.env.STELLAR_SRL_COLD_PUBLIC_KEY, 'multifirma 2 de 3'],
  ['canal de comisiones',  process.env.STELLAR_MASTER_PUBLIC,       'paga comisiones de red'],
  ['firma de sesiones',    process.env.STELLAR_SEP10_PUBLIC_KEY,    'no opera fondos'],
];

async function traer(pub) {
  const r = await fetch(`${HORIZON}/accounts/${pub}`);
  if (r.status === 404) return { inexistente: true };
  if (!r.ok) throw new Error(`Horizon ${r.status} para ${pub}`);
  return r.json();
}

const num = n => Number(n).toLocaleString('es-BO', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

console.log('');
console.log(`  Estado de la tesorería en la red principal · ${new Date().toISOString()}`);
console.log(`  ${HORIZON}`);
console.log('');

let operativaLibre = null;

for (const [rol, pub, nota] of CUENTAS) {
  console.log(`  ── ${rol} ──`);
  if (!pub) { console.log('     no configurada\n'); continue; }
  console.log(`     dirección     ${pub}`);
  console.log(`     rol           ${nota}`);

  const a = await traer(pub);
  if (a.inexistente) { console.log('     ⚠️  la cuenta NO existe en la red\n'); continue; }

  const xlm  = Number(a.balances.find(b => b.asset_type === 'native')?.balance ?? 0);
  const usdc = a.balances.find(b => b.asset_code === 'USDC');
  const minimo = (2 + a.subentry_count) * BASE_RESERVE;
  const libre  = xlm - minimo;

  console.log(`     firmantes     ${a.signers.length} → ${a.signers.map(s => `${s.key.slice(0, 8)}…(peso ${s.weight})`).join(', ')}`);
  console.log(`     umbrales      bajo ${a.thresholds.low_threshold} · medio ${a.thresholds.med_threshold} · alto ${a.thresholds.high_threshold}`);
  console.log(`     subentradas   ${a.subentry_count}`);
  console.log(`     XLM           ${num(xlm)}   (mínimo ${num(minimo)} · libre ${num(libre)})`);
  if (usdc) console.log(`     USDC          ${num(usdc.balance)}`);

  // Diagnóstico del esquema, por rol.
  const maestra = a.signers.find(s => s.key === pub)?.weight ?? 0;
  if (rol.startsWith('reserva')) {
    const bien = maestra === 0 && a.thresholds.med_threshold >= 2 && a.signers.filter(s => s.weight > 0).length >= 3;
    console.log(`     esquema       ${bien ? '✓ multifirma constituida' : '✗ NO constituida'}`);
  } else if (rol.startsWith('operativa')) {
    operativaLibre = libre;
    console.log(`     esquema       ${maestra > 0 && a.thresholds.med_threshold <= 1
      ? '✓ firma simple, como corresponde a la operativa'
      : '⚠️ revisar: la operativa debe poder firmar sola o los pagos automáticos se detienen'}`);
  }
  console.log('');
}

// ── Verificación 0.1 ───────────────────────────────────────────────────────────

console.log('  ══ margen para crear la cuenta de reserva ══');
console.log(`     mínimo inmovilizado de una cuenta 2 de 3 con línea de confianza : ${num(MINIMO_RESERVA)} XLM`);
console.log(`     fondeo recomendado (el ensayado en la red de prueba)            : ${num(RECOMENDADO_RESERVA)} XLM`);

if (operativaLibre === null) {
  console.log('     ⚠️  no se pudo determinar el margen de la operativa');
} else {
  console.log(`     margen libre en la operativa                                   : ${num(operativaLibre)} XLM`);
  console.log('');
  if (operativaLibre >= RECOMENDADO_RESERVA + 1) {
    console.log('   ✓ alcanza, con margen para comisiones');
  } else if (operativaLibre >= MINIMO_RESERVA) {
    console.log('   ⚠️  alcanza para el mínimo estricto, pero deja la operativa sin margen de comisiones.');
    console.log('      La operativa firma los pagos automáticos: quedarse sin XLM los detiene.');
  } else {
    const falta = RECOMENDADO_RESERVA + 1 - operativaLibre;
    console.log('   ✗ NO ALCANZA. Hay que fondear XLM antes de ejecutar la constitución.');
    console.log(`      Faltan al menos ${num(falta)} XLM para operar con margen.`);
  }
}
console.log('');
