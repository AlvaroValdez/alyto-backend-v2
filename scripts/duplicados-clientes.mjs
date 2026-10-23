#!/usr/bin/env node
/**
 * duplicados-clientes.mjs — ¿Qué personas tienen más de una cuenta?
 *
 * SOLO LECTURA por defecto. Se ejecuta dentro del contenedor de producción, donde
 * `MONGODB_URI` y la DEK ya están en el entorno del proceso.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * En `users` el único índice único es el correo, así que una persona puede abrir
 * cuentas nuevas indefinidamente y cada una levanta su propia verificación de
 * identidad. El 2026-10-10 se encontró el primer caso real revisando a mano el
 * panel de Stripe: nada en el sistema lo señalaba.
 *
 * [clientDuplicateAlert] cubre de acá en adelante —avisa cuando entra una cuenta
 * nueva que coincide con otra—, pero no dice nada del padrón que ya existe. Eso es
 * lo que hace este informe, y es también la herramienta para decidir **cuál cuenta
 * se conserva**: por eso imprime antigüedad, estado del KYC, movimientos y saldos
 * de cada una, que es lo que hace la decisión obvia o no.
 *
 * ── Por qué no agrupa por el campo `identityDocument.number` ────────────────
 *
 * Porque con el cifrado activo ese campo vale el literal `ENCRYPTED` para TODOS los
 * usuarios (y `PENDING_VERIFICATION` para los que nunca declararon su CI). Un
 * `$group` por ese campo mete a todo el padrón en dos grupos gigantes y reporta un
 * duplicado donde no hay nada. El número real se obtiene con `readDocumentNumber()`,
 * que descifra, y para comparar se usa su huella.
 *
 * ── Modos ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/duplicados-clientes.mjs              informe (no escribe nada)
 *   node scripts/duplicados-clientes.mjs --json       mismo informe, para pegar en un ticket
 *   node scripts/duplicados-clientes.mjs --backfill   calcula y guarda las claves faltantes
 *
 * `--backfill` escribe ÚNICAMENTE `identityDocument.numberFingerprint` y `phoneTail`,
 * nunca el número ni el teléfono. Hay que correrlo una vez tras desplegar, porque
 * sin esas claves la detección en el registro no ve a los usuarios ya existentes:
 * encontraría la coincidencia solo entre cuentas nuevas.
 */

import mongoose from 'mongoose';

import { readDocumentNumber } from '../src/utils/clientDocument.js';
import { ensureDek } from '../src/services/piiCrypto.js';
import {
  documentFingerprint,
  ensureFingerprintKey,
  phoneTail,
  PHONE_TAIL_LENGTH,
} from '../src/services/clientIdentityIndex.js';

const BACKFILL = process.argv.includes('--backfill');
const JSON_OUT = process.argv.includes('--json');

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('✗ Falta MONGODB_URI. Correr dentro del contenedor, no desde local.');
  process.exit(1);
}

await mongoose.connect(uri);
const db = mongoose.connection.db;

// La DEK hace falta para descifrar el CI; sin ella el informe solo puede agrupar por
// teléfono y hay que decirlo, no degradar en silencio a "no hay duplicados".
let hayDek = true;
try { await ensureDek(); } catch { hayDek = false; }
const hayHuella = Boolean(await ensureFingerprintKey());

const users = await db.collection('users').find({}, {
  projection: {
    email: 1, firstName: 1, lastName: 1, phone: 1, phoneTail: 1, createdAt: 1,
    legalEntity: 1, role: 1, accountType: 1, kycStatus: 1, kycApprovedAt: 1,
    dateOfBirth: 1, nationality: 1, residenceCountry: 1, deletionStatus: 1,
    'identityDocument.number': 1,
    'identityDocument.numberCiphertext': 1,
    'identityDocument.numberFingerprint': 1,
    'stellarAccount.publicKey': 1,
    stripeVerificationSessionId: 1,
  },
}).toArray();

// ── Claves de cada usuario ────────────────────────────────────────────────────
// Se recalculan en vez de leerse del documento, porque el padrón actual todavía no
// las tiene: si el informe dependiera del campo guardado, antes del backfill diría
// que no hay duplicados. El backfill es consecuencia del informe, no su requisito.

const filas = [];
for (const u of users) {
  let numero = null;
  try { numero = readDocumentNumber(u); } catch { /* ciphertext ilegible */ }

  filas.push({
    u,
    huella:    await documentFingerprint(numero),
    tail:      phoneTail(u.phone ?? null),
    guardada:  u.identityDocument?.numberFingerprint ?? null,
    tailGuardado: u.phoneTail ?? null,
  });
}

// ── Agrupación ────────────────────────────────────────────────────────────────

function agrupar(clave) {
  const grupos = new Map();
  for (const f of filas) {
    const k = clave(f);
    if (!k) continue;
    grupos.set(k, [...(grupos.get(k) ?? []), f]);
  }
  return [...grupos.entries()].filter(([, g]) => g.length > 1);
}

/**
 * Las tres señales, de más a menos concluyente. El orden importa: define con qué
 * fuerza se etiqueta un grupo que coincide por varias.
 */
const SENALES = [
  { id: 'documento',  fuerza: 'fuerte', etiqueta: 'mismo documento',
    clave: f => f.huella },
  { id: 'telefono',   fuerza: 'media',  etiqueta: 'mismo teléfono',
    clave: f => f.tail },
  // Señal débil, para ver lo que las otras dos no alcanzan: alguien que se registró
  // dos veces sin declarar CI y con teléfonos distintos. Sirve para mirar, no para
  // concluir — dos hermanos comparten apellido y hay fechas de nacimiento repetidas.
  { id: 'nacimiento', fuerza: 'débil',  etiqueta: 'misma fecha de nacimiento y apellido',
    clave: f => (f.u.dateOfBirth && f.u.lastName
      ? `${new Date(f.u.dateOfBirth).toISOString().slice(0, 10)}|${String(f.u.lastName).trim().toUpperCase()}`
      : null) },
];

/**
 * Agrupa por **conjunto de cuentas vinculadas**, no por señal.
 *
 * La primera versión recorría las tres señales por separado y el caso real salía
 * tres veces —una por documento, una por teléfono, una por fecha de nacimiento—
 * con las mismas dos cuentas repetidas. Un informe que lista tres veces el mismo
 * problema invita a tratarlo como tres, y sobre todo entrena a saltearlo.
 *
 * Cada señal compartida es una arista entre dos cuentas; lo que interesa es la
 * componente conexa, o sea la persona. Que coincidan por varias señales no son
 * varios hallazgos: es un hallazgo más sólido, y así se reporta.
 */
function agruparPorPersona() {
  const padre = new Map(filas.map(f => [String(f.u._id), String(f.u._id)]));
  const buscar = (x) => (padre.get(x) === x ? x : (padre.set(x, buscar(padre.get(x))), padre.get(x)));
  const unir   = (a, b) => { const ra = buscar(a), rb = buscar(b); if (ra !== rb) padre.set(ra, rb); };

  // Qué señales enlazan cada par, para poder explicarlo después.
  const porPar = new Map();
  for (const senal of SENALES) {
    for (const [, grupo] of agrupar(senal.clave)) {
      for (let i = 0; i < grupo.length; i += 1) {
        for (let j = i + 1; j < grupo.length; j += 1) {
          const a = String(grupo[i].u._id), b = String(grupo[j].u._id);
          unir(a, b);
          const k = [a, b].sort().join('|');
          porPar.set(k, [...(porPar.get(k) ?? []), senal.id]);
        }
      }
    }
  }

  const componentes = new Map();
  for (const f of filas) {
    const raiz = buscar(String(f.u._id));
    componentes.set(raiz, [...(componentes.get(raiz) ?? []), f]);
  }

  return [...componentes.values()]
    .filter(g => g.length > 1)
    .map(grupo => {
      const ids = grupo.map(f => String(f.u._id));
      const senales = new Set();
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          (porPar.get([ids[i], ids[j]].sort().join('|')) ?? []).forEach(s => senales.add(s));
        }
      }
      const presentes = SENALES.filter(s => senales.has(s.id));
      return { grupo, senales: presentes, fuerza: presentes[0]?.fuerza ?? 'débil' };
    })
    // Lo más concluyente primero: es el orden en que conviene atenderlo.
    .sort((a, b) => SENALES.findIndex(s => s.fuerza === a.fuerza)
                  - SENALES.findIndex(s => s.fuerza === b.fuerza));
}

// ── Actividad de cada cuenta, que es lo que decide cuál se conserva ──────────

async function actividad(userId) {
  const [txs, wtx, bob, usdc] = await Promise.all([
    db.collection('transactions').countDocuments({ userId }),
    db.collection('wallettransactions').countDocuments({ userId }),
    db.collection('walletbobs').findOne({ userId }, { projection: { balance: 1, balanceFrozen: 1 } }),
    db.collection('walletusdcs').findOne({ userId }, { projection: { balance: 1, balanceFrozen: 1 } }),
  ]);
  return {
    transacciones: txs,
    movimientos:   wtx,
    saldoBOB:      bob?.balance ?? 0,
    saldoUSDC:     usdc?.balance ?? 0,
    congeladoBOB:  bob?.balanceFrozen ?? 0,
    congeladoUSDC: usdc?.balanceFrozen ?? 0,
  };
}

// ── Informe ───────────────────────────────────────────────────────────────────

const fecha = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—');
const ancho = 78;

async function describir(f) {
  const a = await actividad(f.u._id);
  return {
    _id:        String(f.u._id),
    email:      f.u.email,
    nombre:     `${f.u.firstName ?? ''} ${f.u.lastName ?? ''}`.trim(),
    telefono:   f.u.phone ?? null,
    entidad:    f.u.legalEntity,
    tipo:       f.u.accountType ?? 'personal',
    rol:        f.u.role ?? 'user',
    kyc:        f.u.kycStatus,
    aprobado:   f.u.kycApprovedAt ?? null,
    creada:     f.u.createdAt ?? null,
    eliminada:  f.u.deletionStatus && f.u.deletionStatus !== 'active' ? f.u.deletionStatus : null,
    stellar:    f.u.stellarAccount?.publicKey ?? null,
    sesionKyc:  f.u.stripeVerificationSessionId ?? null,
    ...a,
  };
}

const informe = { padron: users.length, dek: hayDek, huella: hayHuella, personas: [] };

for (const { grupo, senales, fuerza } of agruparPorPersona()) {
  informe.personas.push({
    fuerza,
    // Los identificadores de las señales, no sus valores: la huella del documento es
    // una clave derivada del CI y no aporta nada a la decisión.
    coincidePor: senales.map(s => s.id),
    motivo:      senales.map(s => s.etiqueta).join(' + '),
    cuentas:     await Promise.all(grupo.map(describir)),
  });
}

const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;

if (JSON_OUT) {
  console.log(JSON.stringify(informe, null, 2));
} else {
  console.log(`\n${'═'.repeat(ancho)}`);
  console.log(`INFORME DE CUENTAS DUPLICADAS — base "${db.databaseName}" · ${users.length} usuarios`);
  console.log('═'.repeat(ancho));
  if (!hayDek)    console.log('⚠️  Sin DEK: no se pudo descifrar ningún documento. Solo agrupa por teléfono.');
  if (!hayHuella) console.log('⚠️  Sin clave de huella: la comparación por documento no operó.');

  if (!informe.personas.length) {
    console.log('\n✓ Ninguna señal de duplicado en el padrón.\n');
  } else {
    console.log(`\n${informe.personas.length} ${informe.personas.length === 1 ? 'persona' : 'personas'} con más de una cuenta.`);
  }

  informe.personas.forEach((p, i) => {
    console.log(`\n${'─'.repeat(ancho)}`);
    console.log(`#${i + 1} · ${plural(p.cuentas.length, 'cuenta', 'cuentas')} · señal ${p.fuerza} · ${p.motivo}`);
    console.log('─'.repeat(ancho));
    for (const c of p.cuentas) {
      console.log(`  ${c.nombre || '(sin nombre)'}  <${c.email}>`);
      console.log(`    _id ........... ${c._id}`);
      console.log(`    alta .......... ${fecha(c.creada)}   ${c.entidad} · ${c.tipo} · ${c.rol}${c.eliminada ? ` · ${c.eliminada}` : ''}`);
      console.log(`    KYC ........... ${c.kyc}${c.aprobado ? ` (aprobado ${fecha(c.aprobado)})` : ''}`);
      console.log(`    teléfono ...... ${c.telefono ?? '—'}`);
      console.log(`    actividad ..... ${plural(c.transacciones, 'transacción', 'transacciones')} · ${plural(c.movimientos, 'movimiento', 'movimientos')} de wallet`);
      console.log(`    saldos ........ Bs ${c.saldoBOB} (congelado ${c.congeladoBOB}) · ${c.saldoUSDC} USDC (congelado ${c.congeladoUSDC})`);
      console.log(`    Stellar ....... ${c.stellar ?? '—'}`);
      console.log(`    sesión Stripe . ${c.sesionKyc ?? '—'}`);
    }
  });

  // Lo que pasa a formar parte de la decisión, no del diagnóstico.
  const conSaldo = informe.personas
    .flatMap(p => p.cuentas)
    .filter(c => c.saldoBOB > 0 || c.saldoUSDC > 0);
  if (conSaldo.length) {
    console.log(`\n${'─'.repeat(ancho)}`);
    console.log('⚠️  Cuentas con saldo entre los duplicados: dar de baja una exige mover el dinero primero.');
    conSaldo.forEach(c => console.log(`    ${c.email} → Bs ${c.saldoBOB} · ${c.saldoUSDC} USDC`));
  }
  console.log();
}

// ── Backfill de las claves de búsqueda ───────────────────────────────────────

if (BACKFILL) {
  console.log(`${'═'.repeat(ancho)}`);
  console.log('BACKFILL de claves de búsqueda (escribe numberFingerprint y phoneTail)');
  console.log('═'.repeat(ancho));

  let huellas = 0, tails = 0, saltados = 0;
  for (const f of filas) {
    const $set = {};
    if (f.huella && f.huella !== f.guardada)  $set['identityDocument.numberFingerprint'] = f.huella;
    if (f.tail   && f.tail   !== f.tailGuardado) $set.phoneTail = f.tail;
    if (!Object.keys($set).length) { saltados += 1; continue; }

    await db.collection('users').updateOne({ _id: f.u._id }, { $set });
    if ($set['identityDocument.numberFingerprint']) huellas += 1;
    if ($set.phoneTail) tails += 1;
  }
  console.log(`  huellas de documento escritas .. ${huellas}`);
  console.log(`  claves de teléfono escritas ..... ${tails}`);
  console.log(`  ya estaban al día ............... ${saltados}`);
  console.log(`  (tramo final del teléfono: últimos ${PHONE_TAIL_LENGTH} dígitos)\n`);
} else {
  const faltanHuella = filas.filter(f => f.huella && !f.guardada).length;
  const faltanTail   = filas.filter(f => f.tail && !f.tailGuardado).length;
  if (faltanHuella || faltanTail) {
    console.log(`${'─'.repeat(ancho)}`);
    console.log(`Claves sin guardar: ${faltanHuella} de documento, ${faltanTail} de teléfono.`);
    console.log('Hasta que se guarden, la detección en el registro NO ve a estos usuarios.');
    console.log('  → node scripts/duplicados-clientes.mjs --backfill\n');
  }
}

await mongoose.disconnect();
