#!/usr/bin/env node
/**
 * regularizar-bob-comprometido.mjs — Devuelve el BOB cobrado y nunca ejecutado.
 *
 *   node scripts/regularizar-bob-comprometido.mjs                      # simulacro
 *   node scripts/regularizar-bob-comprometido.mjs --apply --by <email> # ejecuta
 *   node scripts/regularizar-bob-comprometido.mjs --apply --by <email> --tx ALY-C-...
 *
 * ── Qué regulariza ──────────────────────────────────────────────────────────
 *
 * `getBOBCommitted` detectó el 2026-10-01 siete operaciones por Bs 3.506 en las
 * que el payin se cobró y el payout nunca se ejecutó ni se devolvió. Se verificó
 * contra la base que ninguna tiene un movimiento de billetera asociado, ni por
 * referencia a la transacción ni por monto exacto, y Alvaro confirmó que tampoco
 * hubo devolución por transferencia bancaria.
 *
 * Las causas fueron del lado nuestro o de los proveedores, no del usuario:
 * customer de Harbor inactivo, wallet maestra de Vita sin saldo, un rechazo del
 * corredor EU ya corregido, y un auto-fail por falta de IPN.
 *
 * ── Cómo devuelve ───────────────────────────────────────────────────────────
 *
 * Acreditando la billetera BOB del usuario, con un `WalletTransaction` de tipo
 * `refund` que deja balanceBefore/balanceAfter, y estampando la evidencia en
 * `Transaction.refund`. Ese campo es el punto: `status:'refunded'` por sí solo no
 * prueba nada, porque se puede poner a mano sin mover un centavo, y en
 * producción hay exactamente un caso así (ALY-C-1786548682442-NE1YVC, Bs 236,
 * marcado como devuelto en agosto sin ningún movimiento detrás).
 *
 * Mientras no exista `refund.wtxId`, `getBOBCommitted` sigue contando el monto
 * como pasivo, que es lo correcto. Este script es lo que hace que deje de serlo,
 * y solo porque el dinero efectivamente volvió.
 *
 * ── Garantías ───────────────────────────────────────────────────────────────
 *
 * - **Simulacro por defecto.** Sin `--apply` no escribe nada.
 * - **Atómico por operación.** Acreditar la billetera, crear el movimiento y
 *   sellar la transacción ocurren en una sola sesión de Mongo. No existe el
 *   estado intermedio "se acreditó pero no quedó registrado".
 * - **Idempotente.** Una transacción que ya tiene `refund.wtxId` se saltea. Correrlo
 *   dos veces no acredita dos veces.
 * - **Exige saber quién lo hizo.** `--by` con el email de un admin existente.
 *   Una devolución sin responsable no es auditable, y esto va a un expediente.
 */
import * as dotenv from 'dotenv'
dotenv.config()

import mongoose from 'mongoose'

const APPLY = process.argv.includes('--apply')
const byIdx = process.argv.indexOf('--by')
const BY_EMAIL = byIdx !== -1 ? process.argv[byIdx + 1] : null
const soloTx = process.argv.reduce((acc, a, i) => (a === '--tx' ? [...acc, process.argv[i + 1]] : acc), [])

if (APPLY && !BY_EMAIL) {
  console.error('Falta --by <email-del-admin>. Una devolución sin responsable no es auditable.')
  process.exit(1)
}

const uri = process.env.MONGODB_URI
if (!uri) { console.error('Falta MONGODB_URI.'); process.exit(1) }

await mongoose.connect(uri)

const { default: Transaction }       = await import('../src/models/Transaction.js')
const { default: WalletBOB }         = await import('../src/models/WalletBOB.js')
const { default: WalletTransaction } = await import('../src/models/WalletTransaction.js')
const { default: User }              = await import('../src/models/User.js')
const { getBOBCommitted }            = await import('../src/services/treasuryLiquidity.js')

let admin = null
if (BY_EMAIL) {
  admin = await User.findOne({ email: String(BY_EMAIL).toLowerCase() }).select('_id email role').lean()
  if (!admin) { console.error(`No existe el usuario ${BY_EMAIL}.`); await mongoose.disconnect(); process.exit(1) }
}

const antes = await getBOBCommitted('SRL')
console.log(`\nModo: ${APPLY ? 'APLICAR' : 'SIMULACRO (no escribe nada)'}`)
if (admin) console.log(`Responsable: ${admin.email} (${admin.role ?? 'sin rol'})`)
console.log(`\nPasivo ANTES: Bs ${antes.committed} en ${antes.operations} operaciones`)
console.log(`  ya debido al usuario : Bs ${antes.refundDue}`)
console.log(`  'refunded' sin prueba: Bs ${antes.refundedUnproven}\n`)

// Mismo criterio que getBOBCommitted: cobrado, no ejecutado, sin prueba de devolución.
const POST_PAYIN = ['payin_confirmed', 'payin_completed', 'processing', 'in_transit',
  'payout_pending', 'payout_sent', 'payout_pending_usdc_send', 'payout_in_transit',
  'pending_funding', 'pending_fx_review']

const filtro = {
  legalEntity: 'SRL', originCurrency: 'BOB',
  status: { $nin: ['completed'] },
  $and: [
    { $or: [
      { status: { $in: POST_PAYIN } },
      { 'bankQr.paidAt': { $ne: null, $exists: true } },
      { 'confirmationDetails.confirmedAt': { $ne: null, $exists: true } },
    ] },
    { $or: [
      { 'refund.wtxId': { $in: [null, ''] } },
      { 'refund.wtxId': { $exists: false } },
    ] },
  ],
}
if (soloTx.length) filtro.alytoTransactionId = { $in: soloTx }

const pendientes = await Transaction.find(filtro).sort({ createdAt: 1 })
console.log(`A regularizar: ${pendientes.length} operaciones\n`)

let devuelto = 0
const fallos = []

for (const tx of pendientes) {
  const monto = Number(tx.originalAmount ?? 0)
  const u = await User.findById(tx.userId).select('email firstName lastName').lean()
  const etiqueta = `${tx.alytoTransactionId}  Bs ${String(monto).padStart(5)}  ${u?.email ?? '?'}`

  if (!(monto > 0)) { console.log(`  ✗ ${etiqueta} — monto inválido, se omite`); continue }

  if (!APPLY) {
    console.log(`  · ${etiqueta} — se acreditaría a su billetera BOB`)
    devuelto += monto
    continue
  }

  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      let wallet = await WalletBOB.findOne({ userId: tx.userId }).session(session)
      if (!wallet) {
        const creada = await WalletBOB.create([{ userId: tx.userId, balance: 0 }], { session })
        wallet = creada[0]
      }

      const saldoAntes   = wallet.balance
      const saldoDespues = saldoAntes + monto

      const [wtx] = await WalletTransaction.create([{
        walletId:      wallet._id,
        userId:        tx.userId,
        type:          'refund',
        currency:      'BOB',
        amount:        monto,
        balanceBefore: saldoAntes,
        balanceAfter:  saldoDespues,
        status:        'completed',
        reference:     tx.alytoTransactionId,
        description:   `Devolución de ${tx.alytoTransactionId}: el cobro se recibió y el pago no se ejecutó`,
        confirmedBy:   admin._id,
        confirmedAt:   new Date(),
        metadata:      { origen: 'regularizar-bob-comprometido', motivoFallo: String(tx.failureReason ?? '').slice(0, 300) },
      }], { session })

      wallet.balance = saldoDespues
      await wallet.save({ session })

      tx.status = 'refunded'
      tx.refund = {
        method:   'walletBOB',
        wtxId:    wtx.wtxId,
        amount:   monto,
        currency: 'BOB',
        at:       new Date(),
        by:       admin._id,
        reason:   'Regularización del BOB cobrado y no ejecutado (pasivo histórico jun-ago 2026)',
      }
      await tx.save({ session })

      console.log(`  ✓ ${etiqueta} → ${wtx.wtxId}  (saldo ${saldoAntes} → ${saldoDespues})`)
      devuelto += monto
    })
  } catch (err) {
    fallos.push({ tx: tx.alytoTransactionId, motivo: err.message })
    console.log(`  ✗ ${etiqueta} — ${err.message}`)
  } finally {
    await session.endSession()
  }
}

console.log('\n' + '─'.repeat(78))
console.log(`${APPLY ? 'Devuelto' : 'Se devolvería'}: Bs ${devuelto} en ${APPLY ? pendientes.length - fallos.length : pendientes.length} operaciones`)
if (fallos.length) {
  console.log(`Fallidas: ${fallos.length}`)
  fallos.forEach(f => console.log(`  ${f.tx}: ${f.motivo}`))
  process.exitCode = 1
}

if (APPLY) {
  const despues = await getBOBCommitted('SRL')
  console.log(`\nPasivo DESPUÉS: Bs ${despues.committed} en ${despues.operations} operaciones`)
  if (despues.committed === 0) console.log('El pasivo quedó en cero y con evidencia por cada devolución.')
} else {
  console.log('\nSimulacro: no se escribió nada. Repetir con --apply --by <email-admin>.')
}

await mongoose.disconnect()
