/**
 * walletControllerTx.test.js — Pruebas de caracterización de las siete funciones
 * transaccionales de la billetera BOB.
 *
 * ## Para qué existen
 *
 * Ninguna de estas siete tenía prueba alguna, y todas mueven dinero. Se escriben
 * ANTES de convertirlas de `startTransaction()` manual a
 * `session.withTransaction()`, y la garantía que dan es simple: pasan contra el
 * código viejo y tienen que seguir pasando contra el nuevo, sin tocarlas.
 *
 * No buscan cubrirlo todo. Cubren lo que un refactor puede romper en silencio:
 *
 *   - el efecto en los saldos del camino feliz;
 *   - que un corte temprano NO deje nada escrito (el riesgo propio de
 *     `withTransaction`, donde retornar hace commit en vez de abortar);
 *   - el código HTTP de cada corte, porque el frontend y el panel los leen.
 */

import { jest } from '@jest/globals'
import '../setup.env.js'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'

// Efectos de borde fuera: no son el objeto de la prueba y saldrían a la red.
await jest.unstable_mockModule('../../src/services/notifications.js', () => ({
  notify:        jest.fn(async () => {}),
  notifyAdmins:  jest.fn(async () => {}),
  NOTIFICATIONS: new Proxy({}, { get: () => () => ({ title: 't', body: 'b', type: 'wallet' }) }),
}))
await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  registerAuditTrail:    jest.fn(async () => ({ hash: 'h' })),
  freezeUserTrustline:   jest.fn(async () => {}),
  unfreezeUserTrustline: jest.fn(async () => {}),
}))
await jest.unstable_mockModule('../../src/services/email.js', () => ({
  sendEmail: jest.fn(async () => {}),
  EMAILS:    new Proxy({}, { get: () => () => ['a@b.c', 'tpl', {}] }),
}))

let rs, C
let User, WalletBOB, WalletTransaction, WalletUSDC, AdminAuditLog

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ args: ['--setParameter', 'maxTransactionLockRequestTimeoutMillis=5000'] }],
  })
  await mongoose.connect(rs.getUri(), { dbName: 'wallettx' })

  User              = (await import('../../src/models/User.js')).default
  WalletBOB         = (await import('../../src/models/WalletBOB.js')).default
  WalletTransaction = (await import('../../src/models/WalletTransaction.js')).default
  WalletUSDC        = (await import('../../src/models/WalletUSDC.js')).default
  AdminAuditLog     = (await import('../../src/models/AdminAuditLog.js')).default

  C = await import('../../src/controllers/walletController.js')

  // Crear colecciones e índices fuera de toda transacción: adentro abortan.
  for (const M of [User, WalletBOB, WalletTransaction, WalletUSDC, AdminAuditLog]) {
    await M.createCollection().catch(() => {})
    await M.init()
  }
}, 180_000)

afterAll(async () => {
  await mongoose.disconnect()
  await rs?.stop()
})

// ─── Arneses ──────────────────────────────────────────────────────────────────

/** Captura lo que el controlador responde, sin Express. */
function resStub() {
  const r = { code: 200, body: null }
  r.status = (c) => { r.code = c; return r }
  r.json   = (b) => { r.body = b; return r }
  return r
}

const reqStub = (over = {}) => ({
  params: {}, body: {}, file: undefined,
  ip: '127.0.0.1', method: 'POST', originalUrl: '/test', headers: {},
  get: () => undefined,
  ...over,
})

let seq = 0
async function crearUsuario(over = {}) {
  seq += 1
  return User.create({
    email:       `u${seq}-${Date.now()}@test.bo`,
    password:    'x'.repeat(20),
    firstName:   'Juana',
    lastName:    'Pérez',
    legalEntity: 'SRL',
    accountType: 'personal',
    identityDocument: { type: 'ci_bolivia', number: `${1000000 + seq}`, issuingCountry: 'BO' },
    ...over,
  })
}

async function crearBilletera(userId, over = {}) {
  return WalletBOB.create({ userId, balance: 1000, balanceReserved: 0, currency: 'BOB', status: 'active', ...over })
}

beforeEach(async () => {
  jest.restoreAllMocks()
  await Promise.all([
    User.deleteMany({}), WalletBOB.deleteMany({}), WalletTransaction.deleteMany({}),
    WalletUSDC.deleteMany({}),
    // AdminAuditLog es append-only y el modelo lanza ante cualquier borrado, así
    // que se vacía por el driver nativo. Esa protección es deliberada: un
    // registro de auditoría no se puede alterar desde la aplicación.
    mongoose.connection.db.collection(AdminAuditLog.collection.name).deleteMany({}),
  ])
})

// ─── 1. sendP2P ───────────────────────────────────────────────────────────────

describe('sendP2P', () => {
  it('mueve el saldo de una billetera a la otra y deja dos movimientos', async () => {
    const emisor = await crearUsuario()
    const dest   = await crearUsuario()
    const wo = await crearBilletera(emisor._id, { balance: 500 })
    const wd = await crearBilletera(dest._id,   { balance: 100 })

    const res = resStub()
    await C.sendP2P(reqStub({ user: emisor, body: { recipientEmail: dest.email, amount: 200 } }), res)

    expect(res.code).toBe(200)
    expect((await WalletBOB.findById(wo._id)).balance).toBe(300)
    expect((await WalletBOB.findById(wd._id)).balance).toBe(300)
    expect(await WalletTransaction.countDocuments({ type: 'send' })).toBe(1)
    expect(await WalletTransaction.countDocuments({ type: 'receive' })).toBe(1)
  })

  it('saldo insuficiente: 400 y NADA escrito', async () => {
    const emisor = await crearUsuario()
    const dest   = await crearUsuario()
    const wo = await crearBilletera(emisor._id, { balance: 50 })
    await crearBilletera(dest._id, { balance: 0 })

    const res = resStub()
    await C.sendP2P(reqStub({ user: emisor, body: { recipientEmail: dest.email, amount: 200 } }), res)

    expect(res.code).toBe(400)
    expect((await WalletBOB.findById(wo._id)).balance).toBe(50)
    expect(await WalletTransaction.countDocuments({})).toBe(0)
  })

  it('la reserva no es gastable', async () => {
    const emisor = await crearUsuario()
    const dest   = await crearUsuario()
    await crearBilletera(emisor._id, { balance: 300, balanceReserved: 250 })
    await crearBilletera(dest._id, { balance: 0 })

    const res = resStub()
    await C.sendP2P(reqStub({ user: emisor, body: { recipientEmail: dest.email, amount: 100 } }), res)

    expect(res.code).toBe(400)
    expect(await WalletTransaction.countDocuments({})).toBe(0)
  })

  it.each([
    ['no SRL',            { legalEntity: 'LLC' }, {}, 403],
    ['sin destinatario',  {}, { amount: 10, recipientEmail: undefined }, 400],
    ['monto bajo el mínimo', {}, { amount: 0.5 },       400],
  ])('%s → %i sin escribir nada', async (_, userOver, bodyOver, esperado) => {
    const emisor = await crearUsuario(userOver)
    await crearBilletera(emisor._id)
    const res = resStub()

    await C.sendP2P(reqStub({ user: emisor, body: { recipientEmail: 'x@y.bo', ...bodyOver } }), res)

    expect(res.code).toBe(esperado)
    expect(await WalletTransaction.countDocuments({})).toBe(0)
  })

  it('enviarse a uno mismo: 400', async () => {
    const emisor = await crearUsuario()
    await crearBilletera(emisor._id)
    const res = resStub()
    await C.sendP2P(reqStub({ user: emisor, body: { recipientEmail: emisor.email, amount: 10 } }), res)
    expect(res.code).toBe(400)
  })

  it('destinatario inexistente: 404', async () => {
    const emisor = await crearUsuario()
    await crearBilletera(emisor._id)
    const res = resStub()
    await C.sendP2P(reqStub({ user: emisor, body: { recipientEmail: 'nadie@test.bo', amount: 10 } }), res)
    expect(res.code).toBe(404)
  })
})

// ─── 2. requestWithdrawal ─────────────────────────────────────────────────────

const CUENTA = { bankName: 'BANECO', accountNumber: '123456', accountHolder: 'Juana Pérez', accountType: 'savings' }

describe('requestWithdrawal', () => {
  it('reserva el monto sin debitar el saldo', async () => {
    const user = await crearUsuario()
    const w = await crearBilletera(user._id, { balance: 1000 })

    const res = resStub()
    await C.requestWithdrawal(reqStub({ user, body: { amount: 300, ...CUENTA } }), res)

    expect(res.code).toBe(201)
    const fresca = await WalletBOB.findById(w._id)
    expect(fresca.balance).toBe(1000)          // no se debita hasta confirmar
    expect(fresca.balanceReserved).toBe(300)   // pero queda comprometido

    const wtx = await WalletTransaction.findOne({ type: 'withdrawal' })
    expect(wtx.status).toBe('pending')
    expect(wtx.reference).toBe(wtx.wtxId)
  })

  it('saldo insuficiente: 400 y sin reserva', async () => {
    const user = await crearUsuario()
    const w = await crearBilletera(user._id, { balance: 150 })

    const res = resStub()
    await C.requestWithdrawal(reqStub({ user, body: { amount: 500, ...CUENTA } }), res)

    expect(res.code).toBe(400)
    expect((await WalletBOB.findById(w._id)).balanceReserved).toBe(0)
    expect(await WalletTransaction.countDocuments({})).toBe(0)
  })

  it('faltan datos de la cuenta: 400 y sin reserva', async () => {
    const user = await crearUsuario()
    const w = await crearBilletera(user._id)

    const res = resStub()
    await C.requestWithdrawal(reqStub({ user, body: { amount: 300, bankName: 'BANECO' } }), res)

    expect(res.code).toBe(400)
    expect((await WalletBOB.findById(w._id)).balanceReserved).toBe(0)
  })

  it('bajo el mínimo de Bs 100: 400', async () => {
    const user = await crearUsuario()
    await crearBilletera(user._id)
    const res = resStub()
    await C.requestWithdrawal(reqStub({ user, body: { amount: 50, ...CUENTA } }), res)
    expect(res.code).toBe(400)
  })

  it('método QR sin imagen adjunta: 400', async () => {
    const user = await crearUsuario()
    await crearBilletera(user._id)
    const res = resStub()
    await C.requestWithdrawal(reqStub({ user, body: { amount: 300, method: 'qr' } }), res)
    expect(res.code).toBe(400)
  })
})

// ─── 3. adminConfirmDeposit ───────────────────────────────────────────────────

describe('adminConfirmDeposit', () => {
  async function sembrarDeposito(over = {}) {
    const user  = await crearUsuario()
    const admin = await crearUsuario()
    const w = await crearBilletera(user._id, { balance: 100 })
    const wtx = await WalletTransaction.create({
      walletId: w._id, userId: user._id, type: 'deposit', currency: 'BOB',
      walletModel: 'WalletBOB', amount: 400, status: 'pending',
      balanceBefore: 100, balanceAfter: 100, ...over,
    })
    return { user, admin, w, wtx }
  }

  it('acredita el saldo', async () => {
    const { admin, w, wtx } = await sembrarDeposito()
    const res = resStub()

    await C.adminConfirmDeposit(reqStub({ user: admin, body: { wtxId: wtx.wtxId, bankReference: 'TRX-9' } }), res)

    expect(res.code).toBe(200)
    expect((await WalletBOB.findById(w._id)).balance).toBe(500)
    expect((await WalletTransaction.findById(wtx._id)).status).toBe('completed')
  })

  it('un depósito por QR no se confirma a mano: 400 y sin crédito', async () => {
    // Ese camino lo acredita el IPN; confirmarlo acá sería doble crédito.
    const { admin, w, wtx } = await sembrarDeposito({ bankQr: { qrId: 'QR-1' } })
    const res = resStub()

    await C.adminConfirmDeposit(reqStub({ user: admin, body: { wtxId: wtx.wtxId, bankReference: 'TRX-9' } }), res)

    expect(res.code).toBe(400)
    expect((await WalletBOB.findById(w._id)).balance).toBe(100)
  })

  it('ya procesado: 400 y sin crédito', async () => {
    const { admin, w, wtx } = await sembrarDeposito({ status: 'completed' })
    const res = resStub()

    await C.adminConfirmDeposit(reqStub({ user: admin, body: { wtxId: wtx.wtxId, bankReference: 'TRX-9' } }), res)

    expect(res.code).toBe(400)
    expect((await WalletBOB.findById(w._id)).balance).toBe(100)
  })

  it('sin referencia bancaria: 400', async () => {
    const { admin, wtx } = await sembrarDeposito()
    const res = resStub()
    await C.adminConfirmDeposit(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)
    expect(res.code).toBe(400)
  })

  it('inexistente: 404', async () => {
    const admin = await crearUsuario()
    const res = resStub()
    await C.adminConfirmDeposit(reqStub({ user: admin, body: { wtxId: 'WTX-NO', bankReference: 'r' } }), res)
    expect(res.code).toBe(404)
  })
})

// ─── 4 y 5. congelar y descongelar ────────────────────────────────────────────

describe('adminFreezeWallet / adminUnfreezeWallet', () => {
  it('congelar mueve el saldo a congelado y deja auditoría', async () => {
    const user  = await crearUsuario()
    const admin = await crearUsuario()
    const w = await crearBilletera(user._id, { balance: 700 })

    const res = resStub()
    await C.adminFreezeWallet(reqStub({
      user: admin, params: { userId: String(user._id) },
      body: { reason: 'oficio de compliance', regulatoryRef: 'ASFI-123' },
    }), res)

    expect(res.code).toBe(200)
    const fresca = await WalletBOB.findById(w._id)
    expect(fresca.status).toBe('frozen')
    expect(fresca.balance).toBe(0)
    expect(fresca.balanceFrozen).toBe(700)
    expect(await WalletTransaction.countDocuments({ type: 'freeze' })).toBe(1)
    // La auditoría va en la MISMA transacción: si no quedó, no debió congelarse.
    expect(await AdminAuditLog.countDocuments({ action: 'wallet.freeze' })).toBe(1)
  })

  it('congelar sin referencia regulatoria: 400 y nada escrito', async () => {
    const user  = await crearUsuario()
    const admin = await crearUsuario()
    const w = await crearBilletera(user._id, { balance: 700 })

    const res = resStub()
    await C.adminFreezeWallet(reqStub({
      user: admin, params: { userId: String(user._id) }, body: { reason: 'porque sí' },
    }), res)

    expect(res.code).toBe(400)
    expect((await WalletBOB.findById(w._id)).status).toBe('active')
    expect(await AdminAuditLog.countDocuments({})).toBe(0)
  })

  it('descongelar devuelve el saldo', async () => {
    const user  = await crearUsuario()
    const admin = await crearUsuario()
    const w = await crearBilletera(user._id, { balance: 0, balanceFrozen: 700, status: 'frozen' })

    const res = resStub()
    await C.adminUnfreezeWallet(reqStub({
      user: admin, params: { userId: String(user._id) }, body: { reason: 'levantada' },
    }), res)

    expect(res.code).toBe(200)
    const fresca = await WalletBOB.findById(w._id)
    expect(fresca.status).toBe('active')
    expect(fresca.balance).toBe(700)
    expect(fresca.balanceFrozen).toBe(0)
    expect(await AdminAuditLog.countDocuments({ action: 'wallet.unfreeze' })).toBe(1)
  })

  it('descongelar una que no está congelada: 400 y sin cambios', async () => {
    const user  = await crearUsuario()
    const admin = await crearUsuario()
    const w = await crearBilletera(user._id, { balance: 500 })

    const res = resStub()
    await C.adminUnfreezeWallet(reqStub({ user: admin, params: { userId: String(user._id) }, body: {} }), res)

    expect(res.code).toBe(400)
    expect((await WalletBOB.findById(w._id)).balance).toBe(500)
    expect(await AdminAuditLog.countDocuments({})).toBe(0)
  })
})

// ─── 6 y 7. confirmar y rechazar un retiro ────────────────────────────────────

describe('adminConfirmWithdrawal / adminRejectWithdrawal', () => {
  async function sembrarRetiro(over = {}) {
    const user  = await crearUsuario()
    const admin = await crearUsuario()
    const w = await crearBilletera(user._id, { balance: 1000, balanceReserved: 300 })
    const wtx = await WalletTransaction.create({
      walletId: w._id, userId: user._id, type: 'withdrawal', currency: 'BOB',
      walletModel: 'WalletBOB', amount: 300, status: 'pending',
      balanceBefore: 1000, balanceAfter: 1000, metadata: { method: 'bank' }, ...over,
    })
    return { user, admin, w, wtx }
  }

  const comprobante = { buffer: Buffer.from('x'), mimetype: 'image/png', originalname: 'p.png', size: 1 }

  it('confirmar debita el saldo y libera la reserva', async () => {
    const { admin, w, wtx } = await sembrarRetiro()
    const res = resStub()

    await C.adminConfirmWithdrawal(reqStub({
      user: admin, body: { wtxId: wtx.wtxId, bankReference: 'ACH-1' }, file: comprobante,
    }), res)

    expect(res.code).toBe(200)
    const fresca = await WalletBOB.findById(w._id)
    expect(fresca.balance).toBe(700)
    expect(fresca.balanceReserved).toBe(0)
    expect((await WalletTransaction.findById(wtx._id)).status).toBe('completed')
  })

  it('confirmar sin comprobante: 400, el saldo intacto', async () => {
    // El comprobante es respaldo ASFI y lo ve el usuario; sin él no se confirma.
    const { admin, w, wtx } = await sembrarRetiro()
    const res = resStub()

    await C.adminConfirmWithdrawal(reqStub({
      user: admin, body: { wtxId: wtx.wtxId, bankReference: 'ACH-1' },
    }), res)

    expect(res.code).toBe(400)
    const fresca = await WalletBOB.findById(w._id)
    expect(fresca.balance).toBe(1000)
    expect(fresca.balanceReserved).toBe(300)
  })

  it('confirmar uno ya procesado: 404 y sin debitar', async () => {
    const { admin, w, wtx } = await sembrarRetiro({ status: 'completed' })
    const res = resStub()

    await C.adminConfirmWithdrawal(reqStub({
      user: admin, body: { wtxId: wtx.wtxId, bankReference: 'ACH-1' }, file: comprobante,
    }), res)

    expect(res.code).toBe(404)
    expect((await WalletBOB.findById(w._id)).balance).toBe(1000)
  })

  it('rechazar libera la reserva SIN debitar', async () => {
    const { admin, w, wtx } = await sembrarRetiro()
    const res = resStub()

    await C.adminRejectWithdrawal(reqStub({ user: admin, body: { wtxId: wtx.wtxId, reason: 'datos mal' } }), res)

    expect(res.code).toBe(200)
    const fresca = await WalletBOB.findById(w._id)
    expect(fresca.balance).toBe(1000)        // el dinero nunca salió
    expect(fresca.balanceReserved).toBe(0)   // vuelve a estar disponible
    expect((await WalletTransaction.findById(wtx._id)).status).toBe('failed')
  })

  it('rechazar uno ya procesado: 404 y la reserva sin tocar', async () => {
    const { admin, w, wtx } = await sembrarRetiro({ status: 'failed' })
    const res = resStub()

    await C.adminRejectWithdrawal(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)

    expect(res.code).toBe(404)
    expect((await WalletBOB.findById(w._id)).balanceReserved).toBe(300)
  })

  it('rechazar sin wtxId: 400', async () => {
    const admin = await crearUsuario()
    const res = resStub()
    await C.adminRejectWithdrawal(reqStub({ user: admin, body: {} }), res)
    expect(res.code).toBe(400)
  })
})
