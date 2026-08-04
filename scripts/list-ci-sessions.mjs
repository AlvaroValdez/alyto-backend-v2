// list-ci-sessions.mjs — read-only. Lista los afectados sin CI y su
// stripeVerificationSessionId, para carga admin manual (opción B).
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
import { isRealDocumentNumber } from '../src/utils/clientDocument.js'
dotenv.config()

const URI = process.env.MONGODB_URI
if (!URI) { console.error('MONGODB_URI ausente'); process.exit(1) }
await mongoose.connect(URI)
const db = mongoose.connection.db
if (db.databaseName !== 'alyto-v2') { console.error(`DB inesperada: ${db.databaseName}`); process.exit(1) }

const users = await db.collection('users').find(
  { kycProfileCompletedAt: { $ne: null } },
  { projection: { email: 1, taxId: 1, 'identityDocument.number': 1, stripeVerificationSessionId: 1, kycStatus: 1, legalEntity: 1 } },
).toArray()

const affected = users.filter(u =>
  !(typeof u.taxId === 'string' && u.taxId.trim()) &&
  !isRealDocumentNumber(u.identityDocument?.number),
)

console.log(`\nAfectados sin CI (${affected.length}) — email · estado · sessionId de Stripe:\n`)
for (const u of affected) {
  console.log(`  ${String(u.email).padEnd(32)} ${String(u.kycStatus).padEnd(9)} ${u.stripeVerificationSessionId ?? '(sin sesión Stripe)'}`)
}
console.log('\n(read-only: no se modificó nada)')
await mongoose.disconnect()
