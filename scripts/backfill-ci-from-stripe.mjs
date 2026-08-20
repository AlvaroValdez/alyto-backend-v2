// backfill-ci-from-stripe.mjs
// Backfill de CI (identityDocument.number) desde los verified_outputs de Stripe
// Identity, para usuarios que completaron el CDD antes del deploy del campo CI y
// quedaron con number='PENDING_VERIFICATION'. Usa SOLO datos ya verificados por
// Stripe (mismo id_number que persiste stripeWebhook.js). No molesta al usuario.
//
// Dry-run por defecto (no escribe). Con --confirm escribe.
// Uso: node scripts/backfill-ci-from-stripe.mjs production [--confirm]
import mongoose from 'mongoose'
import Stripe from 'stripe'
import * as dotenv from 'dotenv'
import { isRealDocumentNumber } from '../src/utils/clientDocument.js'
dotenv.config()

const TARGET  = process.argv[2]
const CONFIRM = process.argv.includes('--confirm')
const URI0    = process.env.MONGODB_URI
const SK      = process.env.STRIPE_SECRET_KEY

if (!['staging', 'production'].includes(TARGET || '')) {
  console.error('❌ Uso: node scripts/backfill-ci-from-stripe.mjs staging|production [--confirm]'); process.exit(1)
}
if (!URI0) { console.error('❌ MONGODB_URI ausente'); process.exit(1) }
if (!SK)   { console.error('❌ STRIPE_SECRET_KEY ausente'); process.exit(1) }

const URI = TARGET === 'staging' ? URI0.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1') : URI0
const stripe = new Stripe(SK)

await mongoose.connect(URI)
const db = mongoose.connection.db
const dbName = db.databaseName
if (TARGET === 'staging'    && dbName !== 'alyto-v2-staging') { console.error('❌ DB inesperada'); process.exit(1) }
if (TARGET === 'production' && dbName !== 'alyto-v2')         { console.error('❌ DB inesperada'); process.exit(1) }

console.log(`\n${CONFIRM ? '⚠️  MODO ESCRITURA' : '🔍 DRY-RUN (solo lectura)'} — ${TARGET.toUpperCase()} · DB "${dbName}"\n`)

const users = await db.collection('users').find(
  { kycProfileCompletedAt: { $ne: null } },
  { projection: { email: 1, taxId: 1, 'identityDocument.number': 1, stripeVerificationSessionId: 1 } },
).toArray()

const affected = users.filter(u =>
  !(typeof u.taxId === 'string' && u.taxId.trim()) &&
  !isRealDocumentNumber(u.identityDocument?.number),
)

const mask = s => s ? String(s).slice(0, 2) + '***' + String(s).slice(-2) : '(vacío)'
let recuperables = 0, sinSession = 0, sinDato = 0, escritos = 0

for (const u of affected) {
  const tag = String(u.email).padEnd(34)
  if (!u.stripeVerificationSessionId) { console.log(`  ${tag} sin sessionId → opción A (reabrir CDD)`); sinSession++; continue }
  let idnum = null
  try {
    const full = await stripe.identity.verificationSessions.retrieve(u.stripeVerificationSessionId, { expand: ['verified_outputs'] })
    idnum = full?.verified_outputs?.id_number?.trim() || null
  } catch (e) { console.log(`  ${tag} error Stripe: ${e.message} → opción A`); sinDato++; continue }
  if (!idnum || !isRealDocumentNumber(idnum)) { console.log(`  ${tag} Stripe sin id_number → opción A (reabrir CDD)`); sinDato++; continue }
  recuperables++
  console.log(`  ${tag} CI recuperable de Stripe: ${mask(idnum)}${CONFIRM ? ' → escribiendo' : ''}`)
  if (CONFIRM) {
    const r = await db.collection('users').updateOne(
      { _id: u._id, 'identityDocument.number': { $in: [null, 'PENDING_VERIFICATION'] } },
      { $set: { 'identityDocument.number': idnum } },
    )
    if (r.modifiedCount === 1) escritos++
  }
}

console.log(`\nAfectados: ${affected.length} · recuperables por Stripe: ${recuperables} · sin sessionId: ${sinSession} · Stripe sin dato: ${sinDato}${CONFIRM ? ` · escritos: ${escritos}` : ''}`)
console.log(CONFIRM ? '\n✅ Escritura completada.' : '\n(dry-run: no se modificó nada. Correr con --confirm para escribir los recuperables.)')
await mongoose.disconnect()
