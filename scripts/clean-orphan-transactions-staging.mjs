/**
 * Elimina transacciones HUÉRFANAS/incompletas en STAGING (solo colección
 * `transactions`): las que nunca completaron (status != 'completed') y/o cuyo
 * userId ya no existe. Deja el ambiente limpio para grabación.
 *
 * NO toca wallet, contactos, ni ninguna otra colección.
 * Seguridad: guarda dura (solo alyto-v2-staging). Dry-run por defecto (--confirm).
 *
 * Uso:
 *   node scripts/clean-orphan-transactions-staging.mjs            # dry-run
 *   node scripts/clean-orphan-transactions-staging.mjs --confirm  # aplica
 */
import 'dotenv/config'
import mongoose from 'mongoose'

const CONFIRM     = process.argv.includes('--confirm')
const EXPECTED_DB = 'alyto-v2-staging'
// Estados que SÍ se conservan (operación real concluida). Todo lo demás = huérfana.
const KEEP_STATUS = new Set(['completed'])

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
const dbName = mongoose.connection.name
console.log(`\n⚠️  OBJETIVO: STAGING — "${dbName}"`)
if (dbName !== EXPECTED_DB) { console.error(`❌ ABORT: base=${dbName}`); await mongoose.connection.close(); process.exit(2) }
console.log(CONFIRM ? '   MODO ESCRITURA (--confirm)\n' : '   DRY-RUN\n')

const db = mongoose.connection.db
const userIds = new Set((await db.collection('users').find({}, { projection:{_id:1} }).toArray()).map(u => String(u._id)))
const all = await db.collection('transactions')
  .find({}, { projection: { alytoTransactionId:1, status:1, createdAt:1, originCountry:1, destinationCountry:1, userId:1 } })
  .sort({ createdAt:-1 }).toArray()

const orphans = all.filter(t => !KEEP_STATUS.has(t.status) || (t.userId && !userIds.has(String(t.userId))))
const keep    = all.filter(t => !orphans.includes(t))

console.log(`transactions total: ${all.length} | a eliminar (huérfanas): ${orphans.length} | a conservar: ${keep.length}\n`)
console.log('A ELIMINAR:')
for (const t of orphans) console.log(`  ✗ ${t.createdAt?.toISOString?.()} | ${t.alytoTransactionId} | ${t.originCountry}→${t.destinationCountry} | ${t.status}${t.userId && !userIds.has(String(t.userId)) ? ' | userId inexistente' : ''}`)
if (keep.length) { console.log('\nA CONSERVAR (completed):'); for (const t of keep) console.log(`  ✓ ${t.alytoTransactionId} | ${t.status}`) }

if (!CONFIRM) { console.log('\n(DRY-RUN) usa --confirm para eliminar.'); await mongoose.connection.close(); process.exit(0) }

const ids = orphans.map(t => t._id)
const r = await db.collection('transactions').deleteMany({ _id: { $in: ids } })
console.log(`\n✓ transacciones huérfanas eliminadas: ${r.deletedCount}`)
await mongoose.connection.close()
