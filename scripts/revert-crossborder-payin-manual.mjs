/**
 * Revierte los corredores cross-border con payinMethod='bankQr' → 'manual'
 * en STAGING (colección real: transaction_configs), para la grabación ASFI.
 *
 * Seguridad: guarda dura (solo alyto-v2-staging), dry-run por defecto (--confirm).
 *
 * Uso:
 *   node scripts/revert-crossborder-payin-manual.mjs            # dry-run
 *   node scripts/revert-crossborder-payin-manual.mjs --confirm  # aplica
 */
import 'dotenv/config'
import mongoose from 'mongoose'

const CONFIRM     = process.argv.includes('--confirm')
const EXPECTED_DB = 'alyto-v2-staging'
const COLL        = 'transaction_configs'

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
const dbName = mongoose.connection.name
console.log(`\n⚠️  OBJETIVO: STAGING — Base de datos: "${dbName}"`)
if (dbName !== EXPECTED_DB) {
  console.error(`❌ ABORTADO: la base es "${dbName}", se esperaba "${EXPECTED_DB}". No se tocó nada.`)
  await mongoose.connection.close(); process.exit(2)
}
console.log(CONFIRM ? '   MODO ESCRITURA (--confirm)\n' : '   DRY-RUN (solo lectura)\n')

const db = mongoose.connection.db
const filter = { payinMethod: 'bankQr' }
const corridors = await db.collection(COLL)
  .find(filter, { projection: { corridorId:1, legalEntity:1, payinMethod:1, payoutMethod:1, 'bankQrConfig.bankId':1 } })
  .toArray()

console.log(`Corredores con payinMethod='bankQr' en ${COLL}: ${corridors.length}`)
for (const c of corridors) {
  console.log(`  • ${c.corridorId}  entity=${c.legalEntity} payin=${c.payinMethod} → manual | payout=${c.payoutMethod} bankId=${c.bankQrConfig?.bankId ?? '-'}`)
}

if (corridors.length === 0) {
  console.log('\n(nada que revertir — ya están en manual/fintoc/etc.)')
  await mongoose.connection.close(); process.exit(0)
}

if (!CONFIRM) {
  console.log('\n(DRY-RUN) No se escribió nada. Repite con --confirm para aplicar.')
  await mongoose.connection.close(); process.exit(0)
}

console.log('\nAplicando…')
const r = await db.collection(COLL).updateMany(filter, { $set: { payinMethod: 'manual' } })
console.log(`  ✓ corredores bankQr→manual: ${r.modifiedCount}`)
console.log('\n✓ Listo — cross-border payin en manual.')

await mongoose.connection.close()
