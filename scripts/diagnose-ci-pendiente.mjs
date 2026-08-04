// scripts/diagnose-ci-pendiente.mjs
// DIAGNÓSTICO (solo lectura) — usuarios que completaron el formulario de
// cumplimiento (CDD) pero NO tienen un CI/RUT real capturado.
//
// Contexto: el campo "Número de documento" se agregó al formulario CDD recién
// en el commit 8064590 (frontend). Quienes completaron el CDD antes de ese
// deploy tienen `identityDocument.number = 'PENDING_VERIFICATION'` y NUNCA
// vuelven a ver el formulario, porque KycProfileForm solo se renderiza cuando
// `!kycProfileCompleted`. Su Comprobante Oficial ASFI imprime "En verificación"
// (resolveClientDocument → ciPending) de forma permanente.
//
// Este script NO escribe nada: no hay --confirm y no ejecuta update alguno.
// Su salida sirve para decidir si hace falta un backfill y de qué tipo.
//
// Uso:
//   node scripts/diagnose-ci-pendiente.mjs staging
//   node scripts/diagnose-ci-pendiente.mjs production
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
import { isRealDocumentNumber } from '../src/utils/clientDocument.js'
dotenv.config()

const PROD_URI = process.env.MONGODB_URI
const TARGET   = process.argv[2]

if (!TARGET || !['staging', 'production'].includes(TARGET)) {
  console.error('❌ Uso: node scripts/diagnose-ci-pendiente.mjs staging|production')
  process.exit(1)
}
if (!PROD_URI) {
  console.error('❌ MONGODB_URI no está configurado en el entorno (.env).')
  process.exit(1)
}

const URI = TARGET === 'staging'
  ? PROD_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')
  : PROD_URI

await mongoose.connect(URI)
const db     = mongoose.connection.db
const dbName = db.databaseName
console.log(`\n🔍 DIAGNÓSTICO (solo lectura) — ${TARGET.toUpperCase()} · DB: "${dbName}"`)
if (TARGET === 'staging'    && dbName !== 'alyto-v2-staging') { console.error('❌ DB inesperada'); process.exit(1) }
if (TARGET === 'production' && dbName !== 'alyto-v2')         { console.error('❌ DB inesperada'); process.exit(1) }

// ── Universo: usuarios que YA completaron el CDD ────────────────────────────
// Son los únicos problemáticos: a los que no lo completaron el formulario les
// aparece igual (ahora con el campo CI) y lo resuelven solos.
const completed = await db.collection('users').find(
  { kycProfileCompletedAt: { $ne: null } },
  { projection: {
      email: 1, kycStatus: 1, legalEntity: 1, kycProfileCompletedAt: 1,
      taxId: 1, 'identityDocument.number': 1, 'identityDocument.type': 1,
  } },
).toArray()

const totalUsers = await db.collection('users').countDocuments()

// Clasificación con la MISMA regla que usa el generador de comprobantes
// (resolveClientDocument): el NIT empresarial tiene prioridad sobre el CI.
const conNit      = []   // business con taxId → el comprobante usa NIT, no afectados
const conCiReal   = []   // ya declararon documento
const afectados   = []   // completaron CDD, sin NIT y sin CI real

for (const u of completed) {
  const num = u.identityDocument?.number
  if (typeof u.taxId === 'string' && u.taxId.trim())  conNit.push(u)
  else if (isRealDocumentNumber(num))                 conCiReal.push(u)
  else                                                afectados.push(u)
}

console.log(`\n── Universo ────────────────────────────────────────────────`)
console.log(`  usuarios totales                     : ${totalUsers}`)
console.log(`  con CDD completado                   : ${completed.length}`)
console.log(`    ├─ con NIT empresarial (no afecta) : ${conNit.length}`)
console.log(`    ├─ con CI/RUT real declarado       : ${conCiReal.length}`)
console.log(`    └─ ⚠️  SIN documento real           : ${afectados.length}`)

if (afectados.length === 0) {
  console.log('\n✅ No hay usuarios afectados. No hace falta backfill.')
  await mongoose.disconnect()
  process.exit(0)
}

// ── Desglose por estado KYC ────────────────────────────────────────────────
// Importa para elegir la estrategia: a un 'approved' no se le puede pedir que
// repita la biometría, pero sí que declare el CI.
const porEstado = {}
const porEntidad = {}
for (const u of afectados) {
  porEstado[u.kycStatus   ?? 'sin-estado'] = (porEstado[u.kycStatus   ?? 'sin-estado'] ?? 0) + 1
  porEntidad[u.legalEntity ?? 'sin-entidad'] = (porEntidad[u.legalEntity ?? 'sin-entidad'] ?? 0) + 1
}
console.log(`\n── Afectados por estado KYC ────────────────────────────────`)
for (const [k, v] of Object.entries(porEstado).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(12)} : ${v}`)
}
console.log(`\n── Afectados por entidad legal ─────────────────────────────`)
for (const [k, v] of Object.entries(porEntidad).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(12)} : ${v}`)
}

// ── Impacto real: ¿ya emitieron comprobantes? ──────────────────────────────
// Un afectado sin transacciones es inofensivo (declarará el CI cuando opere).
// Un afectado CON transacciones ya tiene comprobantes ASFI con "En verificación".
const ids = afectados.map(u => u._id)
const contarPorUsuario = async (coleccion) => {
  const filas = await db.collection(coleccion).aggregate([
    { $match: { userId: { $in: ids } } },
    { $group: { _id: '$userId', n: { $sum: 1 } } },
  ]).toArray()
  return new Map(filas.map(f => [String(f._id), f.n]))
}

const [wtx, tx] = await Promise.all([
  contarPorUsuario('wallettransactions').catch(() => new Map()),
  contarPorUsuario('transactions').catch(() => new Map()),
])

const conMovimientos = afectados
  .map(u => ({
    u,
    n: (wtx.get(String(u._id)) ?? 0) + (tx.get(String(u._id)) ?? 0),
  }))
  .filter(x => x.n > 0)
  .sort((a, b) => b.n - a.n)

console.log(`\n── Impacto en comprobantes ASFI ────────────────────────────`)
console.log(`  afectados CON movimientos (prioridad): ${conMovimientos.length}`)
console.log(`  afectados sin movimientos            : ${afectados.length - conMovimientos.length}`)

if (conMovimientos.length > 0) {
  console.log(`\n  Top afectados con movimientos:`)
  for (const { u, n } of conMovimientos.slice(0, 20)) {
    const fecha = u.kycProfileCompletedAt?.toISOString().slice(0, 10) ?? '?'
    console.log(`    - ${String(u.email).padEnd(34)} ${String(n).padStart(4)} mov · ${u.kycStatus} · CDD ${fecha}`)
  }
  if (conMovimientos.length > 20) console.log(`    … y ${conMovimientos.length - 20} más`)
}

// ── Ventana temporal ───────────────────────────────────────────────────────
// Si todos los afectados completaron el CDD antes del deploy del campo CI
// (2026-07-30), el problema está acotado y no sigue creciendo.
const fechas = afectados.map(u => u.kycProfileCompletedAt).filter(Boolean).sort((a, b) => a - b)
if (fechas.length > 0) {
  console.log(`\n── Ventana temporal ────────────────────────────────────────`)
  console.log(`  CDD más antiguo : ${fechas[0].toISOString().slice(0, 10)}`)
  console.log(`  CDD más reciente: ${fechas[fechas.length - 1].toISOString().slice(0, 10)}`)
  const DEPLOY_CI = new Date('2026-07-30T22:23:00Z')   // recreate del contenedor alyto-frontend
  const posteriores = fechas.filter(f => f > DEPLOY_CI).length
  if (posteriores > 0) {
    console.log(`  ⚠️  ${posteriores} completaron el CDD DESPUÉS del deploy del campo CI`)
    console.log(`      → no es solo deuda histórica: hay una vía activa que sigue dejando usuarios sin CI`)
    console.log(`      (sospechar app Android, que hornea su propio bundle sin el campo)`)
  } else {
    console.log(`  ✅ todos anteriores al deploy → problema acotado, no crece`)
  }
}

console.log(`\n(no se modificó ningún dato)`)
await mongoose.disconnect()
