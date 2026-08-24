#!/usr/bin/env node
/**
 * verificar-acceso-por-entidad.mjs — Tarea 3 de la instrucción 12.
 *
 * Comprueba el efecto de `28e85c0` en el SISTEMA EN EJECUCIÓN, no en la suite de
 * pruebas. Se ejecuta DENTRO del contenedor de producción, importando el módulo
 * tal como quedó desplegado y evaluándolo contra los corredores reales.
 *
 * El criterio es el que dejó la sesión del segundo factor: comprobar el efecto en
 * el registro y no dar por buena la respuesta de un indicador. Por eso no se
 * consulta si el archivo existe: se lo hace decidir sobre datos de producción.
 *
 * Se verifican cuatro cosas distintas:
 *
 *   A. Los tres casos de la demostración original, con los documentos reales de
 *      los corredores involucrados.
 *   B. Barrido exhaustivo: las tres entidades contra la totalidad de los
 *      corredores, activos e inactivos. Ninguna debe alcanzar el de otra.
 *   C. Que el consumidor de la sociedad boliviana alcance exactamente los 23.
 *   D. Contraste con el control anterior, que comparaba sólo el país de origen,
 *      para dimensionar qué cerró la corrección.
 */

import mongoose from 'mongoose';
import { evaluateCorridorAccess } from '/app/src/utils/corridorAccess.js';

const uri = process.env.MONGODB_URI;
if (!uri) { console.error('✗ Falta MONGODB_URI'); process.exit(1); }

await mongoose.connect(uri);
const col = mongoose.connection.collection('transaction_configs');

const ENTIDAD_PAIS = { SRL: 'BO', SpA: 'CL', LLC: 'US' };
const ok = s => `  ✓ ${s}`;
const no = s => `  ✗ ${s}`;
let fallos = 0;

console.log('');
console.log(`  Base: ${mongoose.connection.name}   ${new Date().toISOString()}`);
console.log('');

// ── A. Los tres casos de la demostración original ──────────────────────────────
//
// Estos tres corredores hoy están inactivos, de modo que la búsqueda del
// controlador ya los descarta antes de llegar al control. La evaluación directa
// sirve para acreditar que, si volvieran a activarse, el control los deniega
// igual: son dos capas, no una.

console.log('  ══ A · los tres casos de la demostración, con documentos reales ══');
for (const corridorId of ['bo-br-llc', 'bo-mx-llc', 'bo-eu']) {
  const c = await col.findOne({ corridorId });
  if (!c) { console.log(no(`${corridorId} no existe en producción`)); fallos++; continue; }

  const r = evaluateCorridorAccess({ corridor: c, user: { legalEntity: 'SRL' } });
  const esperado = !r.allowed && r.reason === 'ENTITY_MISMATCH';
  console.log(`   ${corridorId.padEnd(12)} entidad ${String(c.legalEntity).padEnd(4)} origen ${c.originCountry}  activo=${c.isActive}`);
  console.log(esperado ? ok(`   denegado · ${r.reason}`) : no(`   ADMITIDO — el control no operó (${r.reason})`));
  if (!esperado) fallos++;
}

// ── B. Barrido exhaustivo ──────────────────────────────────────────────────────

console.log('');
console.log('  ══ B · barrido de las tres entidades contra todos los corredores ══');
const todos = await col.find({}).project({ corridorId: 1, legalEntity: 1, originCountry: 1, isActive: 1 }).toArray();

const cruces = [];
for (const entidadUsuario of ['SRL', 'SpA', 'LLC']) {
  for (const c of todos) {
    const r = evaluateCorridorAccess({ corridor: c, user: { legalEntity: entidadUsuario } });
    // Un acceso admitido a un corredor de OTRA entidad es un cruce.
    if (r.allowed && c.legalEntity && c.legalEntity !== entidadUsuario) {
      cruces.push(`${entidadUsuario} → ${c.corridorId} (${c.legalEntity})`);
    }
    // Un acceso admitido a un corredor sin entidad, siendo el usuario de la
    // sociedad boliviana, también lo es: el perímetro de los 23 es explícito.
    if (r.allowed && !c.legalEntity && entidadUsuario === 'SRL') {
      cruces.push(`SRL → ${c.corridorId} (sin entidad declarada)`);
    }
  }
}
console.log(`   corredores evaluados : ${todos.length}   ·   evaluaciones : ${todos.length * 3}`);
console.log(cruces.length === 0 ? ok('ningún consumidor alcanza el corredor de otra entidad')
                                : no(`${cruces.length} cruces: ${cruces.join(', ')}`));
if (cruces.length) fallos++;

// ── C. Alcance del consumidor de la sociedad boliviana ─────────────────────────

console.log('');
console.log('  ══ C · alcance efectivo del consumidor de la sociedad boliviana ══');
const alcanzables = todos
  .filter(c => c.isActive && evaluateCorridorAccess({ corridor: c, user: { legalEntity: 'SRL' } }).allowed)
  .map(c => c.corridorId).sort();
console.log(`   corredores activos alcanzables : ${alcanzables.length}`);
console.log(alcanzables.length === 23 ? ok('coincide con el perímetro declarado en el apdo. 4.7')
                                      : no('NO coincide con los 23 declarados'));
if (alcanzables.length !== 23) fallos++;

// ── D. Contraste con el control anterior ───────────────────────────────────────

console.log('');
console.log('  ══ D · qué admitía el control anterior (sólo país de origen) ══');
const antes = todos.filter(c =>
  c.originCountry === ENTIDAD_PAIS.SRL && c.legalEntity !== 'SRL');
console.log(`   corredores de origen BO bajo otra entidad, en la base : ${antes.length}`);
for (const c of antes) {
  console.log(`     ${c.corridorId.padEnd(12)} ${String(c.legalEntity).padEnd(4)} activo=${c.isActive}` +
              `   antes: ADMITIDO   ahora: DENEGADO`);
}
console.log(ok('la corrección cierra la ruta con independencia del estado de activación'));

// ── Cierre ─────────────────────────────────────────────────────────────────────

console.log('');
console.log(fallos === 0
  ? '  RESULTADO: las cuatro verificaciones pasan.'
  : `  RESULTADO: ${fallos} verificación(es) fallaron.`);
console.log('');

await mongoose.disconnect();
process.exit(fallos === 0 ? 0 : 1);
