#!/usr/bin/env node
/**
 * backfill-cuenta-de-cobro.mjs — Deja explícito dónde cayó cada cobro viejo.
 *
 *   node scripts/backfill-cuenta-de-cobro.mjs                  # simulacro
 *   node scripts/backfill-cuenta-de-cobro.mjs --apply
 *   node scripts/backfill-cuenta-de-cobro.mjs --apply --cuenta 2111088816
 *
 * `bankQr.accountCredit` se empezó a registrar en octubre de 2026, junto con la
 * segregación por destino de fondos. Los cobros anteriores no lo tienen, pero
 * no son ambiguos: hasta esa fecha **existía una sola cuenta**, así que todos
 * cayeron en `BEC_ACCOUNT_CREDIT`.
 *
 * Dejarlos sin marcar obligaría a recordar esa excepción cada vez que se mire el
 * reporte por cuenta, y el día que convivan tres cuentas nadie va a recordarla.
 * Esto convierte un supuesto implícito en un dato.
 *
 * Solo toca registros que YA tienen `bankQr` y NO tienen `accountCredit`. No
 * reescribe ninguno que ya lo traiga: si un cobro quedó marcado con otra cuenta,
 * esa información es más confiable que esta suposición.
 */
import * as dotenv from 'dotenv'
dotenv.config()

import mongoose from 'mongoose'

const APPLY  = process.argv.includes('--apply')
const iCta   = process.argv.indexOf('--cuenta')
const CUENTA = iCta !== -1 ? process.argv[iCta + 1] : process.env.BEC_ACCOUNT_CREDIT

if (!CUENTA) {
  console.error('No hay cuenta: definir BEC_ACCOUNT_CREDIT o pasar --cuenta <numero>.')
  process.exit(1)
}

const uri = process.env.MONGODB_URI
if (!uri) { console.error('Falta MONGODB_URI.'); process.exit(1) }
await mongoose.connect(uri)
const db = mongoose.connection.db

// `$in: [null, '']` no matchea un campo AUSENTE, así que el caso se cubre aparte.
const filtroCompleto = {
  'bankQr.qrId': { $exists: true },
  $or: [
    { 'bankQr.accountCredit': { $exists: false } },
    { 'bankQr.accountCredit': { $in: [null, ''] } },
  ],
}

console.log(`\nModo: ${APPLY ? 'APLICAR' : 'SIMULACRO (no escribe nada)'}`)
console.log(`Cuenta a estampar: ${CUENTA}\n`)

for (const col of ['wallettransactions', 'transactions']) {
  const n = await db.collection(col).countDocuments(filtroCompleto)
  const conCuenta = await db.collection(col).countDocuments({
    'bankQr.qrId': { $exists: true },
    'bankQr.accountCredit': { $nin: [null, ''] },
  })
  console.log(`  ${col.padEnd(20)} sin cuenta: ${String(n).padStart(4)} | ya marcados: ${conCuenta}`)

  if (APPLY && n > 0) {
    const r = await db.collection(col).updateMany(filtroCompleto, {
      $set: { 'bankQr.accountCredit': CUENTA },
    })
    console.log(`  ${''.padEnd(20)} → actualizados: ${r.modifiedCount}`)
  }
}

if (!APPLY) console.log('\nSimulacro: no se escribió nada. Repetir con --apply.')
await mongoose.disconnect()
