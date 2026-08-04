// backfill-ci-manual.mjs — carga admin de CI (Cédula de Identidad) para usuarios
// afectados sin documento (identityDocument.number = 'PENDING_VERIFICATION'),
// con los números leídos del documento verificado en Stripe cuando el
// verified_outputs no trae id_number (ver backfill-ci-from-stripe.mjs primero).
//
// Los pares email=CI se pasan por CLI, NUNCA se hardcodean (el repo es público).
// Idempotente: solo escribe si el CI actual es null/PENDING_VERIFICATION.
// Dry-run por defecto; --confirm escribe.
//
// Uso:
//   node scripts/backfill-ci-manual.mjs production "usuario@dominio.com=1234567" [...] [--confirm]
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
import { isRealDocumentNumber } from '../src/utils/clientDocument.js'
dotenv.config()

const args    = process.argv.slice(2)
const TARGET  = args.find(a => ['staging', 'production'].includes(a))
const CONFIRM = args.includes('--confirm')
const pairs   = args
  .filter(a => a.includes('=') && !a.startsWith('--'))
  .map(a => { const i = a.indexOf('='); return [a.slice(0, i).trim().toLowerCase(), a.slice(i + 1).trim()] })

if (!TARGET) { console.error('❌ Uso: node scripts/backfill-ci-manual.mjs staging|production "email=CI" [...] [--confirm]'); process.exit(1) }
if (pairs.length === 0) { console.error('❌ Pasá al menos un par email=CI'); process.exit(1) }
const URI0 = process.env.MONGODB_URI
if (!URI0) { console.error('❌ MONGODB_URI ausente'); process.exit(1) }

const URI = TARGET === 'staging' ? URI0.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1') : URI0
await mongoose.connect(URI)
const db = mongoose.connection.db
const expected = TARGET === 'staging' ? 'alyto-v2-staging' : 'alyto-v2'
if (db.databaseName !== expected) { console.error(`❌ DB inesperada: ${db.databaseName}`); process.exit(1) }

console.log(`\n${CONFIRM ? '⚠️  MODO ESCRITURA' : '🔍 DRY-RUN (solo lectura)'} — ${TARGET.toUpperCase()} · DB "${db.databaseName}"\n`)
let escritos = 0, omitidos = 0
for (const [email, ci] of pairs) {
  if (!isRealDocumentNumber(ci)) { console.log(`  ${email.padEnd(32)} ❌ CI inválido: ${ci}`); omitidos++; continue }
  const u = await db.collection('users').findOne({ email }, { projection: { 'identityDocument.number': 1 } })
  if (!u) { console.log(`  ${email.padEnd(32)} ❌ no encontrado`); omitidos++; continue }
  const cur = u.identityDocument?.number
  if (isRealDocumentNumber(cur)) { console.log(`  ${email.padEnd(32)} ⏭️  ya tenía CI real — sin cambio`); omitidos++; continue }
  console.log(`  ${email.padEnd(32)} ${String(cur).padEnd(22)} → ${ci}${CONFIRM ? '  ✅ escrito' : ''}`)
  if (CONFIRM) {
    const r = await db.collection('users').updateOne(
      { _id: u._id, 'identityDocument.number': { $in: [null, 'PENDING_VERIFICATION'] } },
      { $set: { 'identityDocument.number': ci } },
    )
    if (r.modifiedCount === 1) escritos++
  }
}
console.log(`\n${CONFIRM ? `✅ Escritos: ${escritos} · omitidos: ${omitidos}` : '(dry-run: no se modificó nada. Correr con --confirm para escribir.)'}`)
await mongoose.disconnect()
