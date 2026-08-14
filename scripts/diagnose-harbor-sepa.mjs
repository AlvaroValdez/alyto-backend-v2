/**
 * diagnose-harbor-sepa.mjs — ¿sigue vivo el bug de SEPA en Harbor?
 *
 * EL BUG (documentado 2026-06-07, ticket abierto con OwlPay): el endpoint
 * /v2/transfers/quotes/:id/requirements devuelve para SEPA un schema con
 *   { account_holder_name, account_number }  +  additionalProperties: false
 * — o sea, "solo estos dos campos y nada más" — pero la implementación real del
 * transfer rechaza con 3004 "required property 'SWIFT_CODE' not found".
 * Harbor se contradice: el schema prohíbe el campo que el backend exige.
 *
 * Por eso SUPPORTED_METHODS_BY_COUNTRY.EU = ['WIRE'], y EU usa el peor riel:
 * WIRE cobra ~17.5 EUR fijos donde SEPA cobra ~0.3%. La diferencia es real —
 * a $87 son ~17 EUR menos para el beneficiario.
 *
 * SOLO LECTURA: pide una cotización y consulta sus requisitos. No crea transfers,
 * no mueve fondos. Una quote de Harbor no compromete nada y caduca sola (~60s).
 *
 * Se necesita correr contra Harbor de PRODUCCIÓN porque el sandbox tiene EU caído
 * por completo (verificado: MX/BR/US/GB cotizan, EU responde 3018).
 *
 * Uso:  docker compose exec -T alyto-backend node scripts/diagnose-harbor-sepa.mjs [monto]
 */

import 'dotenv/config';
import { getHarborQuote, getHarborTransferRequirements, getCustomerUuid } from '../src/services/owlPayService.js';

const MONTO = Number(process.argv.find(a => /^[0-9.]+$/.test(a)) ?? 100);

function campos(schema) {
  const props = schema?.properties ?? schema?.schema?.properties ?? null;
  if (!props) return null;
  const req = new Set(schema?.required ?? schema?.schema?.required ?? []);
  return Object.keys(props).map(k => `${k}${req.has(k) ? '*' : ''}`);
}

function additionalProps(schema) {
  const v = schema?.additionalProperties ?? schema?.schema?.additionalProperties;
  return v === undefined ? '(no declarado)' : String(v);
}

/**
 * Barrido de TODOS los destinos Harbor. Se agregó al descubrir que EU responde
 * 3018 también en producción: había que saber si es solo EU o si el proveedor
 * está caído para todos los corredores.
 */
async function barrido() {
  const DESTINOS = [
    ['EU','EUR'], ['MX','MXN'], ['BR','BRL'], ['US','USD'], ['GB','GBP'], ['JP','JPY'],
    ['SG','SGD'], ['IN','INR'], ['AE','AED'], ['CN','CNY'], ['NG','NGN'], ['HK','HKD'],
  ];
  console.log(`Harbor: ${process.env.OWLPAY_BASE_URL ?? process.env.OWLPAY_API_URL}`);
  console.log(`Barrido de destinos con ${MONTO} USDC\n`);
  console.log('  país  resultado');
  let ok = 0, fallan = [];
  for (const [pais, mon] of DESTINOS) {
    try {
      const qs = await getHarborQuote({
        sourceAmount: MONTO, sourceCurrency: 'USDC',
        sourceChain: process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
        destCountry: pais, destCurrency: mon,
        customerUuid: getCustomerUuid('LLC'), returnAll: true,
      });
      const l = Array.isArray(qs) ? qs : [qs];
      console.log(`  ${pais.padEnd(5)} ✓ ${l.map(q => `${q.paymentMethod}:${q.destinationAmount}`).join('  ')}`);
      ok++;
    } catch (e) {
      const msg = String(e.message).replace(/\s+/g, ' ').slice(0, 70);
      console.log(`  ${pais.padEnd(5)} ✗ ${msg}`);
      fallan.push(pais);
    }
  }
  console.log(`\n  ${ok}/${DESTINOS.length} destinos cotizan` +
              (fallan.length ? ` · fallan: ${fallan.join(', ')}` : ''));
}

async function main() {
  if (process.argv.includes('--barrido')) return barrido();

  console.log(`Harbor: ${process.env.OWLPAY_BASE_URL ?? process.env.OWLPAY_API_URL}`);
  console.log(`Cotizando ${MONTO} USDC → EUR\n`);

  const quotes = await getHarborQuote({
    sourceAmount: MONTO,
    sourceCurrency: 'USDC',
    sourceChain: process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
    destCountry: 'EU', destCurrency: 'EUR',
    customerUuid: getCustomerUuid('LLC'),
    returnAll: true,
  });

  const lista = Array.isArray(quotes) ? quotes : [quotes];
  console.log(`── ${lista.length} método(s) que ofrece Harbor ──`);
  for (const q of lista) {
    console.log(`  ${String(q.paymentMethod).padEnd(14)} → ${q.destinationAmount} EUR` +
                `  · tasa ${q.exchangeRate ?? '?'}  · quote ${q.quoteId}`);
  }

  const sepa = lista.find(q => /sepa/i.test(q.paymentMethod ?? ''));
  if (!sepa) {
    console.log('\n⚠️  Harbor ya NO ofrece SEPA para EU. El bug es irrelevante: no hay nada que reactivar.');
    return;
  }

  console.log(`\n── requisitos que Harbor declara para SEPA (quote ${sepa.quoteId}) ──`);
  const reqs = await getHarborTransferRequirements({ quoteId: sepa.quoteId, destCountry: 'EU' });

  const lista2 = campos(reqs) ?? campos(reqs?.destination) ?? null;
  console.log(`  campos               : ${lista2 ? lista2.join(', ') : '(no se pudo leer el schema)'}`);
  console.log(`  additionalProperties : ${additionalProps(reqs)}`);

  const crudo = JSON.stringify(reqs);
  const pideSwift = /swift/i.test(crudo);
  console.log(`  menciona SWIFT       : ${pideSwift ? 'SÍ' : 'NO'}`);

  console.log('\n── veredicto ──');
  if (pideSwift) {
    console.log('  ✅ El schema YA declara SWIFT/BIC. La contradicción desapareció:');
    console.log('     buildPayoutInstrument ya lo envía y el formulario EU ya lo pide.');
    console.log('     → Se puede reactivar SEPA en SUPPORTED_METHODS_BY_COUNTRY.EU');
    console.log('       y en SUPPORTED_HARBOR_METHODS del frontend, y validar con un');
    console.log('       envío real de monto mínimo antes de abrirlo a todos.');
  } else if (additionalProps(reqs) === 'false') {
    console.log('  ❌ El bug SIGUE: el schema prohíbe campos extra y no incluye SWIFT,');
    console.log('     pero el transfer lo exige (error 3004). Sin cambio de parte de OwlPay');
    console.log('     no se puede reactivar. Insistir con el ticket de soporte.');
  } else {
    console.log('  🟡 El schema no menciona SWIFT pero TAMPOCO prohíbe campos extra');
    console.log('     (additionalProperties no es false). Enviar swift_code de más debería');
    console.log('     pasar la validación y satisfacer al backend. Vale un envío real de');
    console.log('     monto mínimo para confirmarlo — es la hipótesis más probable de fix.');
  }

  console.log(`\n  Recordatorio: solo se pidieron cotizaciones. No se creó ningún transfer.`);
}

main().catch(err => {
  console.error('\n✗ Falló el diagnóstico:', err.message);
  process.exit(1);
});
