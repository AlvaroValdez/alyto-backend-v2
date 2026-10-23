#!/usr/bin/env node
/**
 * harbor-route-floors.mjs — Descubre el piso REAL de cada ruta Harbor. SOLO LECTURA
 * salvo que se pase --apply.
 *
 * POR QUÉ EXISTE (barrido de producción 2026-10-05): creíamos que Harbor aceptaba
 * $30–9998 de forma global. Es falso: el piso es POR RUTA. `bo-jp` exige
 * `source.amount >= 75.02` contra los 31 que asumíamos, y como el mínimo configurado
 * del corredor (40 USD) ya superaba ese genérico, el guard de `corridorMinimums.js`
 * nunca se disparaba. Resultado: el usuario cotizaba $50, pagaba en BOB, y el payout
 * moría en Harbor con el cobro ya tomado.
 *
 * Este script pregunta el piso a Harbor en vez de adivinarlo, y lo deja en
 * `TransactionConfig.providerFloorUSD`, donde `providerFloorUSD()` lo compone con
 * el genérico tomando el mayor de los dos.
 *
 *   node scripts/harbor-route-floors.mjs                 # sondea e informa
 *   node scripts/harbor-route-floors.mjs --json          # salida parseable
 *   node scripts/harbor-route-floors.mjs --apply         # además escribe en Mongo
 *   node scripts/harbor-route-floors.mjs --corridor bo-jp
 *
 * Sólo pide COTIZACIONES (`POST /v2/transfers/quotes`). Nunca crea un transfer, así
 * que no mueve dinero ni consume saldo. Es seguro correrlo contra producción.
 *
 * ⚠️ Correrlo DENTRO del contenedor del VPS: los secretos de Harbor viven en AWS
 * Secrets Manager y `loadSecretsIntoEnv()` tiene que resolverlos antes de importar
 * los servicios (regla 21). Sin eso, owlPayService cae a sandbox y los pisos que
 * devuelve son de mentira.
 *
 * ⚠️ El piso es un valor VIVO. El 75,02 de JP tiene toda la pinta de ser un mínimo
 * denominado en moneda destino convertido a USD a la tasa del día: se mueve con el
 * FX. Re-correr este script periódicamente en vez de confiar en lo escrito.
 */
import mongoose from 'mongoose';

import { loadSecretsIntoEnv } from '../src/utils/awsSecrets.js';

await loadSecretsIntoEnv();

const TransactionConfig = (await import('../src/models/TransactionConfig.js')).default;
const { getHarborQuote, getCustomerUuid, resolveHarborCountry } =
  await import('../src/services/owlPayService.js');

const JSON_OUT   = process.argv.includes('--json');
const APPLY      = process.argv.includes('--apply');
const soloIdx    = process.argv.indexOf('--corridor');
const SOLO       = soloIdx !== -1 ? process.argv[soloIdx + 1] : null;

/** Monto con el que se provoca el rechazo para que Harbor confiese su mínimo. */
const SONDEO_BAJO = 1;
/** Techo de la búsqueda binaria. Harbor acepta hasta 9998, pero ningún piso
 *  retail razonable vive por encima de esto y acota el número de llamadas. */
const TECHO_USD   = 400;
/** Pausa entre llamadas — no castigar la API de un socio en producción. */
const PAUSA_MS    = 350;

const dormir = ms => new Promise(r => setTimeout(r, ms));

/**
 * Intenta una cotización. Devuelve el resultado en vez de lanzar, porque acá un
 * rechazo es información útil, no un error.
 */
async function cotizar(corridor, sourceAmount) {
  try {
    const quotes = await getHarborQuote({
      sourceAmount,
      sourceCurrency: 'USDC',
      sourceChain:    process.env.OWLPAY_SOURCE_CHAIN ?? 'stellar',
      destCountry:    resolveHarborCountry(corridor.destinationCountry),
      destCurrency:   corridor.destinationCurrency,
      customerUuid:   getCustomerUuid(corridor.legalEntity ?? 'SRL'),
      returnAll:      true,
    });
    const lista = Array.isArray(quotes) ? quotes : [quotes];
    return { ok: true, metodos: lista.map(q => q.paymentMethod).filter(Boolean) };
  } catch (err) {
    return {
      ok:      false,
      mensaje: err.message ?? String(err),
      code:    err.data?.code ?? err.data?.error?.code ?? null,
      // El cuerpo completo es donde a veces viaja el número, cuando el `message`
      // viene genérico y el detalle está en `details` o en `errors`.
      cuerpo:  err.data ? JSON.stringify(err.data) : '',
    };
  }
}

/**
 * Saca el mínimo del texto del rechazo. Harbor lo dice en claro
 * ("source.amount must be greater than or equal to 75.02"), así que una llamada
 * alcanza; la binaria queda sólo como red por si cambian la redacción.
 */
function parsearMinimo(fallo) {
  const heno = `${fallo.mensaje} ${fallo.cuerpo}`;
  const patrones = [
    /greater\s+than\s+or\s+equal\s+to\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i,
    /(?:must\s+be\s*)?>=\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i,
    /at\s+least\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i,
    /minimum(?:\s+(?:of|is|amount))?\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i,
  ];
  for (const p of patrones) {
    const m = heno.match(p);
    if (m) {
      const n = Number(m[1]);
      if (isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * Busca el piso por bisección entre un monto que falla y uno que pasa.
 * Precisión 0,5 USD: suficiente para fijar un piso que después se redondea.
 */
async function biseccion(corridor, bajoFalla, altoPasa) {
  let lo = bajoFalla, hi = altoPasa;
  while (hi - lo > 0.5) {
    const medio = Math.round(((lo + hi) / 2) * 100) / 100;
    await dormir(PAUSA_MS);
    const r = await cotizar(corridor, medio);
    if (r.ok) hi = medio; else lo = medio;
  }
  return Math.ceil(hi * 100) / 100;
}

async function sondearCorredor(corridor) {
  const base = {
    corridorId:  corridor.corridorId,
    destino:     `${corridor.destinationCountry}/${corridor.destinationCurrency}`,
    minAmountUSD: corridor.minAmountUSD ?? null,
    floorGuardado: corridor.providerFloorUSD ?? null,
  };

  // 1. Provocar el rechazo con un monto deliberadamente bajo.
  const bajo = await cotizar(corridor, SONDEO_BAJO);

  if (bajo.ok) {
    // Acepta $1: la ruta no tiene piso propio por encima del genérico.
    return { ...base, estado: 'sin-piso-propio', floorUSD: null, metodos: bajo.metodos };
  }

  // 3018 = moneda local no habilitada para nuestro customer. No es un piso: es
  // una habilitación de cuenta pendiente con OwlPay (el caso de bo-br).
  if (bajo.code === 3018 || /not\s+enabled|3018/i.test(bajo.mensaje)) {
    return { ...base, estado: 'ruta-no-habilitada', floorUSD: null, detalle: bajo.mensaje };
  }

  // 2. Preguntar directo: el mensaje suele traer el número.
  const declarado = parsearMinimo(bajo);

  if (declarado != null) {
    // Verificar antes de creerle: el declarado debe pasar y un centavo menos fallar.
    await dormir(PAUSA_MS);
    const enElPiso = await cotizar(corridor, declarado);
    await dormir(PAUSA_MS);
    const bajoElPiso = await cotizar(corridor, Math.round((declarado - 0.01) * 100) / 100);

    if (enElPiso.ok && !bajoElPiso.ok) {
      return {
        ...base, estado: 'piso-confirmado', floorUSD: declarado,
        metodos: enElPiso.metodos, fuente: 'declarado-y-verificado',
      };
    }
    if (enElPiso.ok) {
      // Pasa en el declarado pero también por debajo → el número del mensaje no
      // es el corte real. Bisecar para no fijar un piso más alto que el verdadero.
      const real = await biseccion(corridor, SONDEO_BAJO, declarado);
      return { ...base, estado: 'piso-confirmado', floorUSD: real, fuente: 'biseccion' };
    }
  }

  // 3. Red de seguridad: ¿hay algún monto que esta ruta acepte?
  await dormir(PAUSA_MS);
  const techo = await cotizar(corridor, TECHO_USD);
  if (!techo.ok) {
    return {
      ...base, estado: 'rechaza-todo', floorUSD: null,
      detalle: `ni $${SONDEO_BAJO} ni $${TECHO_USD}: ${techo.mensaje}`,
    };
  }

  const real = await biseccion(corridor, SONDEO_BAJO, TECHO_USD);
  return { ...base, estado: 'piso-confirmado', floorUSD: real, fuente: 'biseccion', metodos: techo.metodos };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('Falta MONGODB_URI. Correr dentro del contenedor del VPS.');
  process.exit(1);
}
await mongoose.connect(uri);

const filtro = { payoutMethod: 'owlPay', isActive: true };
if (SOLO) filtro.corridorId = SOLO;

const corredores = await TransactionConfig.find(filtro)
  .select('corridorId destinationCountry destinationCurrency legalEntity minAmountUSD minAmountUSDBusiness providerFloorUSD')
  .lean();

if (!corredores.length) {
  console.error(SOLO ? `No hay corredor Harbor activo con id ${SOLO}.` : 'No hay corredores Harbor activos.');
  await mongoose.disconnect();
  process.exit(1);
}

if (!JSON_OUT) {
  console.log(`\nSondeando ${corredores.length} ruta(s) Harbor. Sólo cotizaciones, sin transfers.\n`);
}

const resultados = [];
for (const c of corredores) {
  const r = await sondearCorredor(c);
  resultados.push(r);
  if (!JSON_OUT) {
    const piso = r.floorUSD != null ? `piso $${r.floorUSD}` : r.estado;
    const vs   = (r.floorUSD != null && r.minAmountUSD != null)
      ? `  (minAmountUSD configurado: $${r.minAmountUSD})`
      : '';
    console.log(`  ${r.corridorId.padEnd(12)} ${r.destino.padEnd(10)} ${piso}${vs}`);
    if (r.detalle) console.log(`  ${''.padEnd(12)} └─ ${r.detalle}`);
  }
  await dormir(PAUSA_MS);
}

// ── Qué habría que cambiar ───────────────────────────────────────────────────
const cambios = resultados.filter(r =>
  r.floorUSD != null && Number(r.floorUSD) !== Number(r.floorGuardado ?? NaN));

if (JSON_OUT) {
  console.log(JSON.stringify({ resultados, cambios }, null, 2));
} else {
  console.log('');
  if (!cambios.length) {
    console.log('Nada que cambiar: los pisos guardados coinciden con los reales.');
  } else {
    console.log(`${cambios.length} corredor(es) con el piso desactualizado:`);
    for (const c of cambios) {
      console.log(`  ${c.corridorId}: providerFloorUSD ${c.floorGuardado ?? 'null'} → ${c.floorUSD}`);
    }
    if (!APPLY) console.log('\nCorrer con --apply para escribirlos.');
  }

  // El que NO tiene piso propio pero sí un 3018 es un problema de habilitación.
  const noHabilitadas = resultados.filter(r => r.estado === 'ruta-no-habilitada');
  if (noHabilitadas.length) {
    console.log(`\n⚠️ ${noHabilitadas.length} ruta(s) no habilitadas en Harbor (conversación con OwlPay, no código):`);
    for (const r of noHabilitadas) console.log(`  ${r.corridorId} — ${r.destino}`);
  }
}

if (APPLY && cambios.length) {
  for (const c of cambios) {
    await TransactionConfig.updateOne(
      { corridorId: c.corridorId },
      { $set: { providerFloorUSD: c.floorUSD } },
    );
  }
  if (!JSON_OUT) console.log(`\n✅ Escritos ${cambios.length} piso(s) en TransactionConfig.`);
}

await mongoose.disconnect();
