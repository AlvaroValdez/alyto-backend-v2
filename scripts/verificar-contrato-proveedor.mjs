/**
 * verificar-contrato-proveedor.mjs — ¿La configuración sigue de acuerdo con el
 * proveedor?
 *
 * SOLO LECTURA. No escribe en la base, no mueve dinero, no crea nada en el
 * proveedor: pide `withdrawal_rules` y `prices`, que son consultas.
 *
 * ── Por qué hace falta un script y no alcanza una prueba ──────────────────────
 *
 * Las pruebas del repo usan `tests/helpers/vitaMock.js`, o sea una respuesta que
 * escribimos nosotros. Un mock no puede detectar que Vita declara VES y la base
 * dice USD: repite lo que ya creemos. Por eso los cuatro desajustes del
 * 2026-10-14 convivieron con 1509 pruebas en verde.
 *
 * La lógica de comparación vive en `src/services/providerContract.js` y SÍ se
 * prueba en CI con fixtures reales. Este script es lo que la enfrenta a la API
 * viva y a la base.
 *
 * ── Uso ───────────────────────────────────────────────────────────────────────
 *
 *   docker compose exec alyto-backend node scripts/verificar-contrato-proveedor.mjs
 *   docker compose exec alyto-backend node scripts/verificar-contrato-proveedor.mjs --json
 *
 * Código de salida: 1 si hay hallazgos CRÍTICOS, 0 si no. Así sirve de guard en
 * un despliegue o en una tarea programada sin leer la salida a ojo.
 *
 * No imprime credenciales.
 */

import { loadSecretsIntoEnv } from '../src/utils/awsSecrets.js';

const JSON_OUT = process.argv.includes('--json');

// Atributos de campo que `validateAgainstVitaFields` consume hoy. Si el
// proveedor agrega uno nuevo, el informe lo expone en vez de que lo
// descubramos cuando una operación falle con el cobro ya emitido.
const ATTR_CONSUMIDOS = [
  'type', 'key', 'name', 'options', 'when',
  'regex_validate', 'regex_message', 'min', 'max',
];

// Claves de país que el código sí usa.
const PAIS_CONSUMIDOS = ['currency_iso_code', 'currency_decimals', 'name'];

async function main() {
  await loadSecretsIntoEnv();

  const [{ default: mongoose }, contrato, vita, minimos] = await Promise.all([
    import('mongoose'),
    import('../src/services/providerContract.js'),
    import('../src/services/vitaWalletService.js'),
    import('../src/services/corridorMinimums.js'),
  ]);

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.name;

  const C = mongoose.connection.collection('transaction_configs');
  const corredores = await C
    .find({ originCountry: 'BO', isActive: true, payoutMethod: 'vitaWallet' })
    .sort({ corridorId: 1 })
    .toArray();

  const reglas = (await vita.getWithdrawalRules()).rules ?? {};
  const precios = await vita.getPrices().catch(() => null);
  const minProv = precios?.usd?.withdrawal?.prices?.attributes?.min_amount ?? {};

  const hallazgos = [];
  const ignorados = new Map();   // atributo -> corredores donde aparece

  for (const c of corredores) {
    const clave = vita.getVitaCountryKey(c.destinationCountry, c.destinationCurrency);
    const r = reglas[clave] ?? null;

    // El mínimo efectivo es el que realmente aplica el create, con el piso del
    // proveedor ya incorporado. Si falla la resolución no se inventa un número:
    // se omite el check y queda registrado por omisión.
    let minEfectivoUSD = null;
    try {
      minEfectivoUSD = (await minimos.resolveEffectiveMinimum(c, 'personal'))?.minUSD ?? null;
    } catch { /* sin tasa de origen no se puede comparar; se omite */ }

    hallazgos.push(...contrato.compararCorredor(c, r, {
      minProveedorUSD: typeof minProv === 'object' ? minProv[clave] : minProv,
      minEfectivoUSD,
    }));

    if (r) {
      for (const k of contrato.camposNoConsumidos(r, PAIS_CONSUMIDOS)) {
        if (!ignorados.has(k)) ignorados.set(k, new Set());
        ignorados.get(k).add(c.corridorId);
      }
      for (const { atributo } of contrato.atributosDeCampoNoConsumidos(r.fields, ATTR_CONSUMIDOS)) {
        const n = `campo.${atributo}`;
        if (!ignorados.has(n)) ignorados.set(n, new Set());
        ignorados.get(n).add(c.corridorId);
      }
    }
  }

  await mongoose.disconnect();

  const criticos = hallazgos.filter(h => h.severidad === contrato.SEVERIDAD.CRITICO);
  const avisos   = hallazgos.filter(h => h.severidad === contrato.SEVERIDAD.AVISO);
  const noConsumidos = [...ignorados.entries()]
    .map(([k, v]) => ({ dato: k, corredores: [...v].sort() }))
    .sort((a, b) => a.dato.localeCompare(b.dato));

  if (JSON_OUT) {
    console.log(JSON.stringify({ db, corredores: corredores.length, criticos, avisos, noConsumidos }, null, 2));
  } else {
    console.log(`\nContrato con el proveedor — base ${db} · ${corredores.length} corredores Vita activos\n`);

    if (!criticos.length) {
      console.log('  ✅ Sin desajustes críticos: configuración y proveedor coinciden.\n');
    } else {
      console.log(`  ❌ ${criticos.length} desajuste(s) CRÍTICO(s):\n`);
      for (const h of criticos) {
        console.log(`     ${h.corridorId} · ${h.check}`);
        console.log(`       esperado: ${h.esperado}   encontrado: ${h.encontrado}`);
        console.log(`       ${h.detalle}\n`);
      }
    }

    if (avisos.length) {
      console.log(`  ⚠️  ${avisos.length} aviso(s):`);
      for (const h of avisos) console.log(`     ${h.corridorId} · ${h.check}: ${h.esperado} vs ${h.encontrado}`);
      console.log('');
    }

    if (noConsumidos.length) {
      console.log('  Datos que el proveedor manda y NO consumimos:');
      for (const { dato, corredores: cs } of noConsumidos) {
        const donde = cs.length > 4 ? `${cs.length} corredores` : cs.join(', ');
        console.log(`     ${dato.padEnd(32)} ${donde}`);
      }
      console.log('\n  (No es un error. Es la lista a revisar cuando el proveedor cambia algo,');
      console.log('   para no enterarnos cuando una operación falle con el cobro emitido.)\n');
    }
  }

  process.exit(criticos.length ? 1 : 0);
}

main().catch((err) => {
  console.error('verificar-contrato-proveedor: fallo inesperado:', err?.message ?? err);
  process.exit(2);
});
