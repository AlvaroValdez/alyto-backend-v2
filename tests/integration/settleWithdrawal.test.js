/**
 * settleWithdrawal.test.js — Liquidar un retiro ya enviado al banco.
 *
 * Esta función no tenía prueba directa contra base de datos: la del job la
 * intercepta entera porque el servidor en memoria de un nodo no soporta
 * transacciones, y es el camino que DEBITA el saldo del usuario. Equivocarse acá
 * tiene dos formas, las dos malas:
 *
 *   - debitar un retiro que el banco nunca pagó;
 *   - dejar la reserva tomada para siempre en uno que sí se rechazó.
 *
 * Se agrega al convertirla a `session.withTransaction()`, porque ese cambio
 * tiene una trampa: ahí **retornar hace commit**, y los cuatro cortes de esta
 * función no son equivalentes. Un webhook repetido y una carrera son resultados
 * correctos; un identificador desconocido o un estado inválido son fallas que el
 * job trata distinto, alertando a una persona.
 */

import { jest } from '@jest/globals'
import '../setup.env.js'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { MongoServerError } from 'mongodb'

// Efectos de borde fuera: el sello on-chain y las notificaciones no son el
// objeto de esta prueba, y sin interceptarlos saldrían a la red.
await jest.unstable_mockModule('../../src/services/notifications.js', () => ({
  notify:        jest.fn(async () => {}),
  notifyAdmins:  jest.fn(async () => {}),
  NOTIFICATIONS: {},
}))
await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  registerAuditTrail:    jest.fn(async () => ({ hash: 'abc' })),
  freezeUserTrustline:   jest.fn(async () => {}),
  unfreezeUserTrustline: jest.fn(async () => {}),
}))

let rs
let WalletTransaction, WalletBOB, settleDispatchedWithdrawal

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ args: ['--setParameter', 'maxTransactionLockRequestTimeoutMillis=5000'] }],
  })
  await mongoose.connect(rs.getUri(), { dbName: 'settletest' })

  WalletTransaction = (await import('../../src/models/WalletTransaction.js')).default
  WalletBOB         = (await import('../../src/models/WalletBOB.js')).default
  settleDispatchedWithdrawal = (await import('../../src/controllers/walletController.js')).settleDispatchedWithdrawal

  for (const M of [WalletTransaction, WalletBOB]) {
    await M.createCollection().catch(() => {})
    await M.init()
  }
}, 180_000)

afterAll(async () => {
  await mongoose.disconnect()
  await rs?.stop()
})

const userId = new mongoose.Types.ObjectId()

/** Retiro de Bs 100 ya ordenado al banco, con el saldo reservado. */
async function sembrarRetiro({ status = 'dispatched', balance = 500, reserved = 100 } = {}) {
  const wallet = await WalletBOB.create({ userId, balance, balanceReserved: reserved, currency: 'BOB' })
  const wtx = await WalletTransaction.create({
    walletId: wallet._id, userId, type: 'withdrawal',
    currency: 'BOB', walletModel: 'WalletBOB', amount: 100, status,
    balanceBefore: balance, balanceAfter: balance,
    metadata: { method: 'bank', disbursementProvider: 'redenlace' },
  })
  return { wallet, wtx }
}

beforeEach(async () => {
  jest.restoreAllMocks()
  await Promise.all([WalletTransaction.deleteMany({}), WalletBOB.deleteMany({})])
})

describe('el banco pagó', () => {
  it('debita el saldo y libera la reserva', async () => {
    const { wallet, wtx } = await sembrarRetiro()

    const r = await settleDispatchedWithdrawal(wtx.wtxId, { accepted: true, bankReference: 'ACH-77' })

    expect(r).toEqual({ ok: true, status: 'completed' })
    const w = await WalletBOB.findById(wallet._id)
    expect(w.balance).toBe(400)
    expect(w.balanceReserved).toBe(0)

    const fresco = await WalletTransaction.findById(wtx._id)
    expect(fresco.status).toBe('completed')
    expect(fresco.balanceAfter).toBe(400)
    expect(fresco.metadata.bankReference).toBe('ACH-77')
  })
})

describe('el banco rechazó', () => {
  it('libera la reserva y NO debita', async () => {
    const { wallet, wtx } = await sembrarRetiro()

    const r = await settleDispatchedWithdrawal(wtx.wtxId, { accepted: false, reason: 'cuenta inexistente' })

    expect(r).toEqual({ ok: true, status: 'failed' })
    const w = await WalletBOB.findById(wallet._id)
    expect(w.balance).toBe(500)          // intacto: el dinero nunca salió
    expect(w.balanceReserved).toBe(0)    // pero el saldo vuelve a estar disponible

    expect((await WalletTransaction.findById(wtx._id)).metadata.rejectReason).toBe('cuenta inexistente')
  })
})

describe('los cuatro cortes no son equivalentes', () => {
  // Es lo que el payload del aborto preserva. Colapsarlos haría que el job de
  // conciliación trate un webhook repetido como una falla, y al revés.
  it('webhook repetido: ok true, no es una falla', async () => {
    const { wtx } = await sembrarRetiro({ status: 'completed' })
    const r = await settleDispatchedWithdrawal(wtx.wtxId, { accepted: true })
    expect(r).toEqual({ ok: true, reason: 'already-settled', status: 'completed' })
  })

  it('identificador desconocido: ok false', async () => {
    const r = await settleDispatchedWithdrawal('WTX-NO-EXISTE', { accepted: true })
    expect(r).toEqual({ ok: false, reason: 'not-found' })
  })

  it('un movimiento que no es retiro: ok false', async () => {
    const wallet = await WalletBOB.create({ userId, balance: 10, currency: 'BOB' })
    const ajeno  = await WalletTransaction.create({
      walletId: wallet._id, userId, type: 'refund', currency: 'BOB',
      walletModel: 'WalletBOB', amount: 10, status: 'dispatched',
      balanceBefore: 10, balanceAfter: 10,
    })
    expect(await settleDispatchedWithdrawal(ajeno.wtxId, { accepted: true }))
      .toEqual({ ok: false, reason: 'not-found' })
  })

  it('estado inválido: ok false y dice cuál era', async () => {
    const { wtx } = await sembrarRetiro({ status: 'pending' })
    const r = await settleDispatchedWithdrawal(wtx.wtxId, { accepted: true })
    expect(r).toEqual({ ok: false, reason: 'bad-status-pending' })
  })
})

describe('transacciones: aborto y reintento', () => {
  it('si pierde la carrera, NO debita el saldo', async () => {
    // El riesgo exacto del cambio a withTransaction: acá ya se calculó el
    // débito, y un `return` en vez de un throw lo confirmaría.
    const { wallet, wtx } = await sembrarRetiro()
    jest.spyOn(WalletTransaction, 'updateOne').mockResolvedValue({ modifiedCount: 0 })

    const r = await settleDispatchedWithdrawal(wtx.wtxId, { accepted: true })

    expect(r).toEqual({ ok: true, reason: 'race' })
    const w = await WalletBOB.findById(wallet._id)
    expect(w.balance).toBe(500)
    expect(w.balanceReserved).toBe(100)
  })

  it('un fallo transitorio se reintenta y debita una sola vez', async () => {
    const { wallet, wtx } = await sembrarRetiro()

    const real = WalletBOB.updateOne.bind(WalletBOB)
    let intentos = 0
    jest.spyOn(WalletBOB, 'updateOne').mockImplementation((...args) => {
      if (++intentos === 1) {
        const err = new MongoServerError({ message: 'conflicto simulado' })
        err.addErrorLabel('TransientTransactionError')
        throw err
      }
      return real(...args)
    })

    const r = await settleDispatchedWithdrawal(wtx.wtxId, { accepted: true })

    expect(r).toEqual({ ok: true, status: 'completed' })
    expect(intentos).toBeGreaterThan(1)
    const w = await WalletBOB.findById(wallet._id)
    expect(w.balance).toBe(400)          // 100 una vez, no 200
    expect(w.balanceReserved).toBe(0)
  })
})
