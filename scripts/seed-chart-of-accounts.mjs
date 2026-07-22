/**
 * seed-chart-of-accounts.mjs — Materializa el plan de cuentas del Libro Mayor.
 *
 * Idempotente (upsert por `code`): correrlo N veces converge al catálogo canónico
 * definido en src/services/ledgerService.js (CHART_OF_ACCOUNTS). No borra cuentas
 * que ya no estén en el catálogo (para no perder historial); solo crea/actualiza.
 *
 * Uso:
 *   node scripts/seed-chart-of-accounts.mjs
 *   (usa MONGODB_URI del .env — apunta a staging en local por convención del proyecto)
 */

import * as dotenv from 'dotenv'
dotenv.config()
import mongoose from 'mongoose'
import { syncChartOfAccounts, CHART_OF_ACCOUNTS } from '../src/services/ledgerService.js'

const URI = process.env.MONGODB_URI
if (!URI) {
  console.error('❌ MONGODB_URI no definida en el entorno.')
  process.exit(1)
}

await mongoose.connect(URI)
const dbName = mongoose.connection.db.databaseName
console.log(`[seed-chart] Conectado a ${dbName} — sembrando ${CHART_OF_ACCOUNTS.length} cuentas...`)

const res = await syncChartOfAccounts()
console.log(`[seed-chart] ✅ Total ${res.total} · creadas ${res.created} · actualizadas ${res.updated}`)

await mongoose.connection.close()
console.log('[seed-chart] Conexión cerrada.')
