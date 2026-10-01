#!/usr/bin/env node
/**
 * bob-committed-report.mjs — Respaldo BOB contra sus dos pasivos. SOLO LECTURA.
 *
 * Imprime el efectivo BOB comprometido (pagos transfronterizos ya cobrados que
 * todavía no se ejecutaron ni se devolvieron) y lo enfrenta al pasivo de wallets,
 * que es la otra mitad de lo que respalda la misma cuenta bancaria.
 *
 *   node scripts/bob-committed-report.mjs
 *   node scripts/bob-committed-report.mjs --json
 *   node scripts/bob-committed-report.mjs --entity LLC
 *
 * No consulta el banco ni mueve nada: solo agrega lo que ya está en la base. Usa
 * `getBOBCommitted`, la misma función que alimenta /admin/treasury/coverage, para
 * que este reporte y el panel no puedan discrepar.
 *
 * `refundDue` es el dato operativo: es el monto que hoy se le debe a usuarios por
 * operaciones que fallaron con el dinero adentro, es decir el pasivo que el motor
 * de reembolso tendrá que regularizar de entrada.
 */
import * as dotenv from 'dotenv'
dotenv.config()

import mongoose from 'mongoose'

const JSON_OUT = process.argv.includes('--json')
const entityArg = process.argv.indexOf('--entity')
const ENTITY   = entityArg !== -1 ? process.argv[entityArg + 1] : 'SRL'

const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('❌ Falta MONGODB_URI.')
  process.exit(1)
}

await mongoose.connect(uri)

const { getBOBCommitted } = await import('../src/services/treasuryLiquidity.js')
const { default: WalletBOB } = await import('../src/models/WalletBOB.js')
const { default: Transaction } = await import('../src/models/Transaction.js')

const committed = await getBOBCommitted(ENTITY)

const walletAgg = await WalletBOB.aggregate([
  { $match: { legalEntity: ENTITY } },
  { $group: {
      _id:      null,
      balance:  { $sum: '$balance' },
      frozen:   { $sum: '$balanceFrozen' },
      reserved: { $sum: '$balanceReserved' },
      wallets:  { $sum: 1 },
  } },
])
const wallets = walletAgg[0] ?? { balance: 0, frozen: 0, reserved: 0, wallets: 0 }

// Desglose de lo ya debido, para saber de qué está hecho el número antes de actuar.
const refundDetail = await Transaction.find({
  legalEntity:    ENTITY,
  originCurrency: 'BOB',
  status:         'failed',
  $or: [
    { 'bankQr.paidAt': { $ne: null, $exists: true } },
    { 'confirmationDetails.confirmedAt': { $ne: null, $exists: true } },
  ],
})
  .select('alytoTransactionId originalAmount failureCategory createdAt payoutReference stellarTxHash')
  .sort({ createdAt: 1 })
  .lean()

// Zona A (nada salió de la casa) vs zona B (el dinero ya se despachó): el reembolso
// automático solo es seguro en la primera. Harbor graba payoutReference ANTES de mover
// el USDC, así que la señal de que salió es stellarTxHash, no la referencia.
const zoneOf = (t) => (t.stellarTxHash ? 'B' : (t.payoutReference ? 'B' : 'A'))
const zoneA = refundDetail.filter(t => zoneOf(t) === 'A')
const zoneB = refundDetail.filter(t => zoneOf(t) === 'B')
const sum   = (rows) => +rows.reduce((a, t) => a + (Number(t.originalAmount) || 0), 0).toFixed(2)

const totalBacking = +(committed.committed + wallets.balance).toFixed(2)

const out = {
  entity:    ENTITY,
  committed,
  walletLiabilities: wallets,
  // Lo que la cuenta bancaria tiene que cubrir en total.
  totalBackingRequiredBOB: totalBacking,
  refundDue: {
    totalBOB:      committed.refundDue,
    operations:    refundDetail.length,
    zoneA:         { operations: zoneA.length, amountBOB: sum(zoneA) },
    zoneB:         { operations: zoneB.length, amountBOB: sum(zoneB) },
    byCategory:    refundDetail.reduce((acc, t) => {
      const k = t.failureCategory ?? 'SIN_CATEGORIA'
      acc[k] = +((acc[k] ?? 0) + (Number(t.originalAmount) || 0)).toFixed(2)
      return acc
    }, {}),
    operationsDetail: refundDetail.map(t => ({
      id:       t.alytoTransactionId,
      amountBOB: t.originalAmount,
      category: t.failureCategory ?? null,
      zone:     zoneOf(t),
      date:     t.createdAt?.toISOString?.().slice(0, 10) ?? null,
    })),
  },
}

if (JSON_OUT) {
  console.log(JSON.stringify(out, null, 2))
} else {
  const bs = (n) => `Bs ${Number(n).toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  console.log(`\n═══ Respaldo BOB requerido — entidad ${ENTITY} ═══\n`)
  console.log(`  Saldos de wallets (Σ balance)      ${bs(wallets.balance).padStart(18)}   ${wallets.wallets} wallets`)
  console.log(`  BOB comprometido                   ${bs(committed.committed).padStart(18)}   ${committed.operations} operaciones`)
  console.log(`    ├─ en curso                      ${bs(committed.inProgress).padStart(18)}`)
  console.log(`    ├─ ya debido al usuario          ${bs(committed.refundDue).padStart(18)}   ${refundDetail.length} operaciones`)
  console.log(`    └─ 'refunded' sin evidencia      ${bs(committed.refundedUnproven).padStart(18)}   etiqueta sin movimiento de wallet`)
  console.log(`  ${'─'.repeat(62)}`)
  console.log(`  TOTAL a cubrir por el banco        ${bs(totalBacking).padStart(18)}\n`)

  if (refundDetail.length > 0) {
    console.log(`  Reembolsos pendientes por zona:`)
    console.log(`    zona A (nada salió, automatizable)   ${bs(sum(zoneA)).padStart(14)}   ${zoneA.length} ops`)
    console.log(`    zona B (dinero despachado, manual)   ${bs(sum(zoneB)).padStart(14)}   ${zoneB.length} ops\n`)
    console.log(`  Por categoría de fallo:`)
    for (const [k, v] of Object.entries(out.refundDue.byCategory).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(26)} ${bs(v).padStart(14)}`)
    }
    console.log(`\n  Operaciones:`)
    for (const t of out.refundDue.operationsDetail) {
      console.log(`    ${t.date ?? '—'.padEnd(10)}  ${String(t.id).padEnd(28)} ${bs(t.amountBOB).padStart(14)}  zona ${t.zone}  ${t.category ?? ''}`)
    }
  } else {
    console.log(`  Sin reembolsos pendientes: ninguna operación falló con el dinero cobrado.`)
  }
  console.log('')
}

await mongoose.disconnect()
