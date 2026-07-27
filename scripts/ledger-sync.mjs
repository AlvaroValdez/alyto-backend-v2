/**
 * ledger-sync.mjs — Proyecta WalletTransaction al Libro Mayor (Fase 2, shadow).
 *
 * Uso:
 *   node scripts/ledger-sync.mjs             # DRY-RUN (no postea; muestra qué haría)
 *   node scripts/ledger-sync.mjs --commit    # postea (idempotente) y avanza el cursor
 *
 * Requiere que exista el asiento de apertura (npm run ledger:opening -- --commit).
 * El script fuerza la ejecución (no exige LEDGER_POSTING_ENABLED); el job programado
 * del server sí respeta el flag.
 */

import * as dotenv from 'dotenv'
dotenv.config()
import mongoose from 'mongoose'
import { syncLedgerFromWalletTx } from '../src/services/ledgerSync.js'

const COMMIT = process.argv.includes('--commit')

const URI = process.env.MONGODB_URI
if (!URI) { console.error('❌ MONGODB_URI no definida.'); process.exit(1) }

await mongoose.connect(URI)
console.log(`[ledger-sync] DB: ${mongoose.connection.db.databaseName} · modo: ${COMMIT ? 'COMMIT' : 'DRY-RUN'}`)

const res = await syncLedgerFromWalletTx({ dryRun: !COMMIT })
console.log('\n' + JSON.stringify(res, null, 2))

await mongoose.connection.close()
