/**
 * seed-staging-from-prod.js
 *
 * Copia las colecciones de configuración de producción (alyto-v2)
 * a staging (alyto-v2-staging). Seguro de correr múltiples veces (upsert).
 *
 * Uso:
 *   node --env-file=.env scripts/seed-staging-from-prod.js
 *
 * Requiere en .env:
 *   MONGODB_URI=mongodb+srv://...@cluster.../alyto-v2?...
 *
 * El script deriva la URI de staging reemplazando el nombre de base de datos.
 *
 * Colecciones copiadas (config, no datos de usuario):
 *   - transaction_configs   (corredores, fees, spread)
 *   - exchangerates         (tasas BOB/USDT, CLP/USD)
 *   - srl_config            (QR Bolivia, datos bancarios SRL)
 *   - spaconfigs            (config Chile SpA)
 *   - sanctionslists        (OFAC/ONU/PEPs — requerido AML)
 *
 * Colecciones NO copiadas (datos de usuarios/transacciones):
 *   users, transactions, wallettransactions, walletbobs, walletusdcs,
 *   fundingrecords, business_profiles, reclamos, contacts,
 *   idempotencykeys, notifications, counters
 */

import mongoose from 'mongoose'

const PROD_URI = process.env.MONGODB_URI
if (!PROD_URI) { console.error('❌ MONGODB_URI no está definido'); process.exit(1) }

// Deriva URI staging reemplazando nombre de base de datos
const STAGING_URI = PROD_URI.replace(/\/alyto-v2(\?|$)/, '/alyto-v2-staging$1')

if (STAGING_URI === PROD_URI) {
  console.error('❌ No se pudo derivar la URI de staging. Verifica que MONGODB_URI contenga /alyto-v2')
  process.exit(1)
}

const COLLECTIONS = [
  'transaction_configs',
  'exchangerates',
  'srl_config',
  'spaconfigs',
  'sanctionslists',
]

console.log('🔗 Conectando a producción...')
const prodConn = await mongoose.createConnection(PROD_URI).asPromise()
console.log(`   ✅ Prod: ${prodConn.db.databaseName}`)

console.log('🔗 Conectando a staging...')
const stagingConn = await mongoose.createConnection(STAGING_URI).asPromise()
console.log(`   ✅ Staging: ${stagingConn.db.databaseName}`)
console.log('')

for (const colName of COLLECTIONS) {
  try {
    const docs = await prodConn.db.collection(colName).find({}).toArray()
    if (docs.length === 0) {
      console.log(`⚠️  ${colName}: vacía en prod — omitida`)
      continue
    }

    const stagingCol = stagingConn.db.collection(colName)

    let upserted = 0
    for (const doc of docs) {
      await stagingCol.replaceOne({ _id: doc._id }, doc, { upsert: true })
      upserted++
    }

    console.log(`✅ ${colName}: ${upserted} documentos copiados`)
  } catch (err) {
    console.error(`❌ ${colName}: ${err.message}`)
  }
}

console.log('')
console.log('✅ Seed completo. Staging listo para pruebas.')

await prodConn.close()
await stagingConn.close()
process.exit(0)
