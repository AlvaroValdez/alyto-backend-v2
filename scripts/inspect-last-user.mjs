// scripts/inspect-last-user.mjs
// Imprime los campos de onboarding/cumplimiento del/los último(s) usuario(s)
// registrado(s). Read-only. Para verificar que el flujo verify-email + form de
// cumplimiento persiste bien en prod (aún sin completar Stripe Identity).
//
// Uso:
//   node scripts/inspect-last-user.mjs staging
//   node scripts/inspect-last-user.mjs production
//   node scripts/inspect-last-user.mjs production 3        # últimos 3
import mongoose from 'mongoose'
import * as dotenv from 'dotenv'
dotenv.config()

const PROD_URI = process.env.MONGODB_URI
const TARGET   = process.argv[2]
const LIMIT    = Number(process.argv[3] ?? 1)

if (!TARGET || !['staging', 'production'].includes(TARGET)) {
  console.error('❌ Uso: node scripts/inspect-last-user.mjs staging|production [N]')
  process.exit(1)
}
const URI = TARGET === 'staging'
  ? PROD_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')
  : PROD_URI

await mongoose.connect(URI)
const db = mongoose.connection.db
console.log(`\n⚠️  ${TARGET.toUpperCase()} — DB: "${db.databaseName}"\n`)

const users = await db.collection('users')
  .find({}, {
    projection: {
      email: 1, firstName: 1, lastName: 1, legalEntity: 1, createdAt: 1,
      kycStatus: 1, emailVerified: 1, kycProfileCompletedAt: 1,
      nationality: 1, sourceOfFunds: 1, dateOfBirth: 1, address: 1, phone: 1,
    },
  })
  .sort({ createdAt: -1 })
  .limit(LIMIT)
  .toArray()

for (const u of users) {
  console.log('──────────────────────────────────────────────')
  console.log(`email:                ${u.email}`)
  console.log(`nombre:               ${u.firstName ?? ''} ${u.lastName ?? ''}`)
  console.log(`legalEntity:          ${u.legalEntity}`)
  console.log(`createdAt:            ${u.createdAt?.toISOString?.() ?? u.createdAt}`)
  console.log(`kycStatus:            ${u.kycStatus}`)
  console.log(`emailVerified:        ${u.emailVerified ?? '(ausente)'}`)
  console.log(`kycProfileCompletedAt:${u.kycProfileCompletedAt ? ' ' + new Date(u.kycProfileCompletedAt).toISOString() : ' (ausente)'}`)
  console.log(`nationality:          ${u.nationality ?? '(ausente)'}`)
  console.log(`sourceOfFunds:        ${u.sourceOfFunds ?? '(ausente)'}`)
  console.log(`dateOfBirth:          ${u.dateOfBirth ? new Date(u.dateOfBirth).toISOString().slice(0,10) : '(ausente)'}`)
  console.log(`phone:                ${u.phone ?? '(ausente)'}`)
  console.log(`address:              ${u.address ? JSON.stringify(u.address) : '(ausente)'}`)
}
console.log('──────────────────────────────────────────────')

await mongoose.disconnect()
process.exit(0)
