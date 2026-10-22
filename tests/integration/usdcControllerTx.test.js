/**
 * usdcControllerTx.test.js — Caracterización de las 9 funciones transaccionales
 * que quedaban: conversiones BOB↔USDC, envío USDC, pago por QR y cierre SEP-24.
 *
 * Mismo contrato que walletControllerTx.test.js: se escriben ANTES de convertir
 * esas funciones de `startTransaction()` manual a `session.withTransaction()`, y
 * tienen que seguir pasando después sin tocarlas. Ninguna tenía prueba.
 *
 * Lo que se verifica es lo que un refactor rompe sin avisar: el efecto en los
 * saldos, que un corte temprano no deje nada escrito, y el código HTTP de cada
 * corte. En las conversiones importa además la RESERVA: confirmar debita y
 * libera, rechazar solo libera. Confundir esas dos es cobrarle al usuario una
 * conversión que no se hizo.
 */

import { jest } from '@jest/globals'
import '../setup.env.js'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { MongoServerError } from 'mongodb'

await jest.unstable_mockModule('../../src/services/notifications.js', () => ({
  notify:               jest.fn(async () => {}),
  notifyAdmins:         jest.fn(async () => {}),
  sendPushNotification: jest.fn(async () => {}),
  NOTIFICATIONS: new Proxy({}, { get: () => () => ({ title: 't', body: 'b', type: 'wallet' }) }),
}))
// El mock tiene que declarar TODOS los exports reales: con módulos ES, si falta
// uno, el import del consumidor falla al enlazar y el error no dice cuál usa.
await jest.unstable_mockModule('../../src/services/stellarService.js', () => ({
  __resetSRLBalanceCacheForTest: jest.fn(),
  buildFeeBumpTransaction:  jest.fn(),
  buildInnerTransaction:    jest.fn(),
  detectIncomingUSDC:       jest.fn(async () => []),
  ensureTrustline:          jest.fn(async () => {}),
  executeStellarPayment:    jest.fn(async () => ({ hash: 'h' })),
  executeWeb3Transit:       jest.fn(async () => ({ hash: 'h' })),
  freezeUserTrustline:      jest.fn(async () => {}),
  getAuditTrail:            jest.fn(async () => []),
  getStellarUSDCBalance:    jest.fn(async () => 1_000_000),
  getStellarXLMBalance:     jest.fn(async () => 100),
  getXLMBalance:            jest.fn(async () => 100),
  hasUSDCTrustline:         jest.fn(async () => true),
  isRetriableStellarError:  jest.fn(() => false),
  registerAuditTrail:       jest.fn(async () => ({ hash: 'h' })),
  sendUSDCToHarbor:         jest.fn(async () => ({ hash: 'h' })),
  submitTransaction:        jest.fn(async () => ({ hash: 'h' })),
  submitWithRetry:          jest.fn(async () => ({ hash: 'h' })),
  unfreezeUserTrustline:    jest.fn(async () => {}),
}))
// La liquidez de tesorería se intercepta para poder forzar un déficit: es la
// única manera de ejercitar el guard, que en el entorno real se consulta
// on-chain. `getBOBCommitted` se deja pasando al módulo real no haría falta acá,
// así que se devuelve un valor inocuo.
const usdcDisponible = jest.fn(async () => ({ available: 1_000_000 }))
await jest.unstable_mockModule('../../src/services/treasuryLiquidity.js', () => ({
  getUSDCAvailableNow:      usdcDisponible,
  getBOBCommitted:          jest.fn(async () => ({ committed: 0, operations: 0 })),
  getCustodialUSDCBacking:  jest.fn(async () => ({ backing: 0 })),
  getTreasuryReserveUSDC:   jest.fn(async () => 0),
  coldPubKey:               jest.fn(() => null),
  minHotUSDC:               jest.fn(() => 0),
  default:                  {},
}))
await jest.unstable_mockModule('../../src/services/email.js', () => ({
  sendEmail:                jest.fn(async () => {}),
  sendRawEmail:             jest.fn(async () => {}),
  sendKycRetryEmail:        jest.fn(async () => {}),
  sendVerificationCodeEmail: jest.fn(async () => {}),
  sendWelcomeEmail:         jest.fn(async () => {}),
  notifyAdminFxGuard:       jest.fn(async () => {}),
  EMAILS: new Proxy({}, { get: () => () => ['a@b.c', 'tpl', {}] }),
}))

let rs, U, A, Q
let User, WalletBOB, WalletUSDC, WalletTransaction, AdminAuditLog

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ args: ['--setParameter', 'maxTransactionLockRequestTimeoutMillis=5000'] }],
  })
  await mongoose.connect(rs.getUri(), { dbName: 'usdctx' })

  User              = (await import('../../src/models/User.js')).default
  WalletBOB         = (await import('../../src/models/WalletBOB.js')).default
  WalletUSDC        = (await import('../../src/models/WalletUSDC.js')).default
  WalletTransaction = (await import('../../src/models/WalletTransaction.js')).default
  AdminAuditLog     = (await import('../../src/models/AdminAuditLog.js')).default

  U = await import('../../src/controllers/walletUSDCController.js')
  A = await import('../../src/controllers/adminController.js')
  Q = await import('../../src/controllers/qrWalletController.js')

  for (const M of [User, WalletBOB, WalletUSDC, WalletTransaction, AdminAuditLog]) {
    await M.createCollection().catch(() => {})
    await M.init()
  }
}, 240_000)

afterAll(async () => {
  await mongoose.disconnect()
  await rs?.stop()
})

// ─── Arneses ──────────────────────────────────────────────────────────────────

function resStub() {
  const r = { code: 200, body: null }
  r.status = (c) => { r.code = c; return r }
  r.json   = (b) => { r.body = b; return r }
  return r
}

const reqStub = (over = {}) => ({
  params: {}, body: {}, file: undefined,
  ip: '127.0.0.1', method: 'POST', originalUrl: '/t', headers: {},
  get: () => undefined,
  ...over,
})

let seq = 0
async function crearUsuario(over = {}) {
  seq += 1
  return User.create({
    email:       `c${seq}-${Date.now()}@test.bo`,
    password:    'x'.repeat(20),
    firstName:   'Juana',
    lastName:    'Pérez',
    legalEntity: 'SRL',
    kycStatus:   'approved',
    accountType: 'personal',
    identityDocument: { type: 'ci_bolivia', number: `${2000000 + seq}`, issuingCountry: 'BO' },
    ...over,
  })
}

const bob  = (userId, over = {}) => WalletBOB.create({ userId, balance: 1000, balanceReserved: 0, currency: 'BOB', status: 'active', ...over })
const usdc = (userId, over = {}) => WalletUSDC.create({ userId, balance: 100, balanceReserved: 0, status: 'active', ...over })

beforeEach(async () => {
  jest.restoreAllMocks()
  usdcDisponible.mockResolvedValue({ available: 1_000_000 })
  // En el entorno real el guard está apagado (`=false` en .env), así que sin esto
  // su código no se ejecutaría nunca en pruebas.
  delete process.env.USDC_CONVERT_LIQUIDITY_GUARD
  await Promise.all([
    User.deleteMany({}), WalletBOB.deleteMany({}), WalletUSDC.deleteMany({}),
    WalletTransaction.deleteMany({}),
    mongoose.connection.db.collection(AdminAuditLog.collection.name).deleteMany({}),
  ])
})

/** Error que el driver SÍ reintenta. Un Error pelado con la etiqueta no sirve. */
function errorTransitorio(msg = 'conflicto simulado') {
  const err = new MongoServerError({ message: msg })
  err.addErrorLabel('TransientTransactionError')
  return err
}

/** Hace fallar la primera llamada a `metodo` del modelo y deja pasar el resto. */
function fallarUnaVez(Model, metodo) {
  const real = Model[metodo].bind(Model)
  const contador = { intentos: 0 }
  jest.spyOn(Model, metodo).mockImplementation((...args) => {
    if (++contador.intentos === 1) throw errorTransitorio()
    return real(...args)
  })
  return contador
}

// ─── 1. requestBOBtoUSDC ──────────────────────────────────────────────────────

describe('requestBOBtoUSDC', () => {
  it('reserva los bolivianos sin debitarlos', async () => {
    const u = await crearUsuario()
    const wb = await bob(u._id, { balance: 1000 })
    await usdc(u._id)

    const res = resStub()
    await U.requestBOBtoUSDC(reqStub({ user: u, body: { amount: 500 } }), res)

    expect(res.code).toBe(201)
    const f = await WalletBOB.findById(wb._id)
    expect(f.balance).toBe(1000)
    expect(f.balanceReserved).toBe(500)
    expect((await WalletTransaction.findOne({ type: 'bob_to_usdc' })).status).toBe('pending')
  })

  it('saldo insuficiente: 400 y sin reserva', async () => {
    const u = await crearUsuario()
    const wb = await bob(u._id, { balance: 60 })
    await usdc(u._id)

    const res = resStub()
    await U.requestBOBtoUSDC(reqStub({ user: u, body: { amount: 500 } }), res)

    expect(res.code).toBe(400)
    expect((await WalletBOB.findById(wb._id)).balanceReserved).toBe(0)
    expect(await WalletTransaction.countDocuments({})).toBe(0)
  })

  it.each([
    ['sin KYC',   { kycStatus: 'pending' }, 500, 403],
    ['no SRL',    { legalEntity: 'LLC' },   500, 403],
    ['bajo el mínimo de Bs 50', {},          10, 400],
  ])('%s → %i y nada escrito', async (_, over, amount, esperado) => {
    const u = await crearUsuario(over)
    const wb = await bob(u._id)
    await usdc(u._id)

    const res = resStub()
    await U.requestBOBtoUSDC(reqStub({ user: u, body: { amount } }), res)

    expect(res.code).toBe(esperado)
    expect((await WalletBOB.findById(wb._id)).balanceReserved).toBe(0)
  })

  it('sin wallet BOB: 400', async () => {
    const u = await crearUsuario()
    const res = resStub()
    await U.requestBOBtoUSDC(reqStub({ user: u, body: { amount: 500 } }), res)
    expect(res.code).toBe(400)
  })
})

// ─── 2 y 3. confirmar y rechazar BOB→USDC ─────────────────────────────────────

describe('adminConfirmBOBtoUSDC / adminRejectBOBtoUSDC', () => {
  async function sembrar(over = {}) {
    const u     = await crearUsuario()
    const admin = await crearUsuario()
    const wb = await bob(u._id,  { balance: 1000, balanceReserved: 500 })
    const wu = await usdc(u._id, { balance: 10 })
    const wtx = await WalletTransaction.create({
      walletId: wb._id, userId: u._id, type: 'bob_to_usdc', currency: 'BOB',
      walletModel: 'WalletBOB', amount: 500, status: 'pending',
      balanceBefore: 1000, balanceAfter: 1000,
      metadata: {
        bobAmount: 500, usdcAmount: 50, walletBOBId: String(wb._id),
        walletUSDCId: String(wu._id), bobPerUsdc: 10, marketRate: 10, spreadPct: 0,
      },
      ...over,
    })
    return { u, admin, wb, wu, wtx }
  }

  it('confirmar debita los bolivianos, libera la reserva y acredita USDC', async () => {
    const { admin, wb, wu, wtx } = await sembrar()
    const res = resStub()

    await U.adminConfirmBOBtoUSDC(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)

    expect(res.code).toBe(200)
    const fb = await WalletBOB.findById(wb._id)
    expect(fb.balance).toBe(500)
    expect(fb.balanceReserved).toBe(0)
    expect((await WalletUSDC.findById(wu._id)).balance).toBe(60)
    expect((await WalletTransaction.findById(wtx._id)).status).toBe('completed')
  })

  it('rechazar libera la reserva SIN debitar ni acreditar', async () => {
    const { admin, wb, wu, wtx } = await sembrar()
    const res = resStub()

    await U.adminRejectBOBtoUSDC(reqStub({ user: admin, body: { wtxId: wtx.wtxId, rejectReason: 'tasa vencida' } }), res)

    expect(res.code).toBe(200)
    const fb = await WalletBOB.findById(wb._id)
    expect(fb.balance).toBe(1000)        // intacto
    expect(fb.balanceReserved).toBe(0)   // liberado
    expect((await WalletUSDC.findById(wu._id)).balance).toBe(10)   // sin acreditar
    expect((await WalletTransaction.findById(wtx._id)).status).toBe('failed')
  })

  it('confirmar una ya procesada: 400 y sin mover saldos', async () => {
    const { admin, wb, wu, wtx } = await sembrar({ status: 'completed' })
    const res = resStub()

    await U.adminConfirmBOBtoUSDC(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)

    expect(res.code).toBe(400)
    expect((await WalletBOB.findById(wb._id)).balance).toBe(1000)
    expect((await WalletUSDC.findById(wu._id)).balance).toBe(10)
  })

  it('rechazar una ya procesada: 400 y sin liberar de nuevo', async () => {
    const { admin, wb, wtx } = await sembrar({ status: 'failed' })
    const res = resStub()

    await U.adminRejectBOBtoUSDC(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)

    expect(res.code).toBe(400)
    expect((await WalletBOB.findById(wb._id)).balanceReserved).toBe(500)
  })

  it('sin wtxId: 400', async () => {
    const admin = await crearUsuario()
    const res = resStub()
    await U.adminConfirmBOBtoUSDC(reqStub({ user: admin, body: {} }), res)
    expect(res.code).toBe(400)
  })

  it('inexistente: 404', async () => {
    const admin = await crearUsuario()
    const res = resStub()
    await U.adminConfirmBOBtoUSDC(reqStub({ user: admin, body: { wtxId: 'WTX-NO' } }), res)
    expect(res.code).toBe(404)
  })
})

// ─── Reintento, carrera y el guard de tesorería ───────────────────────────────

describe('BOB→USDC: reintento, carrera y guard de liquidez', () => {
  async function sembrar(over = {}) {
    const u     = await crearUsuario()
    const admin = await crearUsuario()
    const wb = await bob(u._id,  { balance: 1000, balanceReserved: 500 })
    const wu = await usdc(u._id, { balance: 10 })
    const wtx = await WalletTransaction.create({
      walletId: wb._id, userId: u._id, type: 'bob_to_usdc', currency: 'BOB',
      walletModel: 'WalletBOB', amount: 500, status: 'pending',
      balanceBefore: 1000, balanceAfter: 1000,
      metadata: {
        bobAmount: 500, usdcAmount: 50, walletBOBId: String(wb._id),
        walletUSDCId: String(wu._id), bobPerUsdc: 10, marketRate: 10, spreadPct: 0,
      },
      ...over,
    })
    return { admin, wb, wu, wtx }
  }

  // ── El defecto que el refactor estuvo a punto de introducir ────────────────
  // El guard corre dentro de un try/catch con fail-open deliberado para el admin.
  // Al convertir el aborto por déficit en un throw, ese catch se lo comía y caía
  // al fail-open: acreditaba USDC sin respaldo, que es lo único que el guard
  // existe para impedir. Si alguien quita el re-throw, esta prueba falla.
  it('déficit de tesorería confirmado: 409 y NO acredita, pese al fail-open del catch', async () => {
    process.env.USDC_CONVERT_LIQUIDITY_GUARD = 'true'
    usdcDisponible.mockResolvedValue({ available: 1 })   // se necesitan 50
    const { admin, wb, wu, wtx } = await sembrar()

    const res = resStub()
    await U.adminConfirmBOBtoUSDC(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)

    expect(res.code).toBe(409)
    expect(res.body.code).toBe('INSUFFICIENT_TREASURY_USDC')
    expect((await WalletUSDC.findById(wu._id)).balance).toBe(10)     // sin acreditar
    expect((await WalletBOB.findById(wb._id)).balance).toBe(1000)    // sin debitar
    expect((await WalletTransaction.findById(wtx._id)).status).toBe('pending')
  })

  it('si NO se puede leer la tesorería y confirma un admin: fail-open, acredita', async () => {
    // Hay una persona evaluando la operación; Horizon caído no debe tumbarla.
    process.env.USDC_CONVERT_LIQUIDITY_GUARD = 'true'
    usdcDisponible.mockRejectedValue(new Error('horizon caído'))
    const { admin, wu, wtx } = await sembrar()

    const res = resStub()
    await U.adminConfirmBOBtoUSDC(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)

    expect(res.code).toBe(200)
    expect((await WalletUSDC.findById(wu._id)).balance).toBe(60)
  })

  it('si NO se puede leer la tesorería y es automática: fail-closed, queda pendiente', async () => {
    // Sin checkpoint humano no se acredita a ciegas.
    process.env.USDC_CONVERT_LIQUIDITY_GUARD = 'true'
    usdcDisponible.mockRejectedValue(new Error('horizon caído'))
    const { wu, wtx } = await sembrar()

    const res = resStub()
    await U.adminConfirmBOBtoUSDC(reqStub({ user: { _id: null }, body: { wtxId: wtx.wtxId, note: 'auto' } }), res)

    expect(res.code).toBe(409)
    expect(res.body.code).toBe('TREASURY_CHECK_UNAVAILABLE')
    expect((await WalletUSDC.findById(wu._id)).balance).toBe(10)
    expect((await WalletTransaction.findById(wtx._id)).status).toBe('pending')
  })

  it('si pierde la carrera por el claim: 409, sin debitar ni acreditar', async () => {
    const { admin, wb, wu, wtx } = await sembrar()
    jest.spyOn(WalletTransaction, 'updateOne').mockResolvedValue({ modifiedCount: 0 })

    const res = resStub()
    await U.adminConfirmBOBtoUSDC(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)

    expect(res.code).toBe(409)
    expect((await WalletBOB.findById(wb._id)).balance).toBe(1000)
    expect((await WalletUSDC.findById(wu._id)).balance).toBe(10)
  })

  it('un fallo transitorio se reintenta y acredita UNA sola vez', async () => {
    const { admin, wb, wu, wtx } = await sembrar()
    const c = fallarUnaVez(WalletUSDC, 'updateOne')

    const res = resStub()
    await U.adminConfirmBOBtoUSDC(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)

    expect(res.code).toBe(200)
    expect(c.intentos).toBeGreaterThan(1)
    expect((await WalletUSDC.findById(wu._id)).balance).toBe(60)   // 50 una vez, no 100
    expect((await WalletBOB.findById(wb._id)).balance).toBe(500)
    expect(await WalletTransaction.countDocuments({ type: 'usdc_deposit' })).toBe(1)
  })

  it('rechazar perdiendo la carrera: 409 y la reserva NO se libera dos veces', async () => {
    const { admin, wb, wtx } = await sembrar()
    jest.spyOn(WalletTransaction, 'updateOne').mockResolvedValue({ modifiedCount: 0 })

    const res = resStub()
    await U.adminRejectBOBtoUSDC(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)

    expect(res.code).toBe(409)
    expect((await WalletBOB.findById(wb._id)).balanceReserved).toBe(500)
  })
})

// ─── 4. requestUSDCtoBOB ──────────────────────────────────────────────────────

describe('requestUSDCtoBOB', () => {
  it('reserva los USDC sin debitarlos', async () => {
    const u = await crearUsuario()
    const wu = await usdc(u._id, { balance: 100 })
    await bob(u._id)

    const res = resStub()
    await U.requestUSDCtoBOB(reqStub({ user: u, body: { amount: 40 } }), res)

    expect(res.code).toBe(201)
    const f = await WalletUSDC.findById(wu._id)
    expect(f.balance).toBe(100)
    expect(f.balanceReserved).toBe(40)
    expect((await WalletTransaction.findOne({ type: 'usdc_to_bob' })).status).toBe('pending')
  })

  it('saldo USDC insuficiente: 400 y sin reserva', async () => {
    const u = await crearUsuario()
    const wu = await usdc(u._id, { balance: 6 })
    await bob(u._id)

    const res = resStub()
    await U.requestUSDCtoBOB(reqStub({ user: u, body: { amount: 40 } }), res)

    expect(res.code).toBe(400)
    expect((await WalletUSDC.findById(wu._id)).balanceReserved).toBe(0)
  })

  it('sin wallet USDC: 400', async () => {
    const u = await crearUsuario()
    await bob(u._id)
    const res = resStub()
    await U.requestUSDCtoBOB(reqStub({ user: u, body: { amount: 40 } }), res)
    expect(res.code).toBe(400)
  })
})

// ─── 5 y 6. confirmar y rechazar USDC→BOB ─────────────────────────────────────

describe('adminConfirmUSDCtoBOB / adminRejectUSDCtoBOB', () => {
  async function sembrar(over = {}) {
    const u     = await crearUsuario()
    const admin = await crearUsuario()
    const wu = await usdc(u._id, { balance: 100, balanceReserved: 40 })
    const wb = await bob(u._id,  { balance: 200 })
    const wtx = await WalletTransaction.create({
      walletId: wu._id, userId: u._id, type: 'usdc_to_bob', currency: 'USDC',
      walletModel: 'WalletUSDC', amount: 40, status: 'pending',
      balanceBefore: 100, balanceAfter: 100,
      metadata: {
        usdcAmount: 40, bobAmount: 400, walletUSDCId: String(wu._id),
        walletBOBId: String(wb._id), bobPerUsdc: 10, marketRate: 10, spreadPct: 0,
      },
      ...over,
    })
    return { u, admin, wu, wb, wtx }
  }

  it('confirmar debita los USDC, libera la reserva y acredita bolivianos', async () => {
    const { admin, wu, wb, wtx } = await sembrar()
    const res = resStub()

    await U.adminConfirmUSDCtoBOB(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)

    expect(res.code).toBe(200)
    const fu = await WalletUSDC.findById(wu._id)
    expect(fu.balance).toBe(60)
    expect(fu.balanceReserved).toBe(0)
    expect((await WalletBOB.findById(wb._id)).balance).toBe(600)
  })

  it('rechazar libera la reserva SIN debitar ni acreditar', async () => {
    const { admin, wu, wb, wtx } = await sembrar()
    const res = resStub()

    await U.adminRejectUSDCtoBOB(reqStub({ user: admin, body: { wtxId: wtx.wtxId, rejectReason: 'sin liquidez' } }), res)

    expect(res.code).toBe(200)
    const fu = await WalletUSDC.findById(wu._id)
    expect(fu.balance).toBe(100)
    expect(fu.balanceReserved).toBe(0)
    expect((await WalletBOB.findById(wb._id)).balance).toBe(200)
    expect((await WalletTransaction.findById(wtx._id)).status).toBe('failed')
  })

  it('confirmar una ya procesada: 400 y sin mover saldos', async () => {
    const { admin, wu, wb, wtx } = await sembrar({ status: 'completed' })
    const res = resStub()

    await U.adminConfirmUSDCtoBOB(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)

    expect(res.code).toBe(400)
    expect((await WalletUSDC.findById(wu._id)).balance).toBe(100)
    expect((await WalletBOB.findById(wb._id)).balance).toBe(200)
  })

  it('rechazar una de otro tipo: 400', async () => {
    const { admin, wtx } = await sembrar({ type: 'bob_to_usdc' })
    const res = resStub()
    await U.adminRejectUSDCtoBOB(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)
    expect(res.code).toBe(400)
  })
})

// ─── 7. sendUSDC ──────────────────────────────────────────────────────────────

describe('sendUSDC', () => {
  it('mueve USDC de una wallet a la otra', async () => {
    const emisor = await crearUsuario({ alytoAlias: 'emisor.aly' })
    const dest   = await crearUsuario({ alytoAlias: 'dest.aly' })
    const we = await usdc(emisor._id, { balance: 100 })
    const wd = await usdc(dest._id,   { balance: 5 })

    const res = resStub()
    await U.sendUSDC(reqStub({ user: emisor, body: { recipientAlias: 'dest.aly', amount: 20 } }), res)

    expect(res.code).toBe(200)
    // La comisión puede ser 0 según configuración; lo invariante es que el
    // emisor baja al menos el monto y el destinatario sube exactamente el monto.
    expect((await WalletUSDC.findById(we._id)).balance).toBeLessThanOrEqual(80)
    expect((await WalletUSDC.findById(wd._id)).balance).toBe(25)
  })

  it('alias inexistente: 404 y nada escrito', async () => {
    const emisor = await crearUsuario({ alytoAlias: 'emisor2.aly' })
    const we = await usdc(emisor._id, { balance: 100 })

    const res = resStub()
    await U.sendUSDC(reqStub({ user: emisor, body: { recipientAlias: 'nadie.aly', amount: 20 } }), res)

    expect(res.code).toBe(404)
    expect((await WalletUSDC.findById(we._id)).balance).toBe(100)
  })

  it('enviarse a uno mismo: 400', async () => {
    const emisor = await crearUsuario({ alytoAlias: 'solo.aly' })
    await usdc(emisor._id, { balance: 100 })

    const res = resStub()
    await U.sendUSDC(reqStub({ user: emisor, body: { recipientAlias: 'solo.aly', amount: 20 } }), res)

    expect(res.code).toBe(400)
  })

  it('saldo insuficiente: no mueve nada', async () => {
    const emisor = await crearUsuario({ alytoAlias: 'pobre.aly' })
    const dest   = await crearUsuario({ alytoAlias: 'rico.aly' })
    const we = await usdc(emisor._id, { balance: 5 })
    const wd = await usdc(dest._id,   { balance: 0 })

    const res = resStub()
    await U.sendUSDC(reqStub({ user: emisor, body: { recipientAlias: 'rico.aly', amount: 50 } }), res)

    expect(res.code).toBeGreaterThanOrEqual(400)
    expect((await WalletUSDC.findById(we._id)).balance).toBe(5)
    expect((await WalletUSDC.findById(wd._id)).balance).toBe(0)
  })
})

// ─── 8. scanAndPayQR ──────────────────────────────────────────────────────────

describe('scanAndPayQR', () => {
  // Se firma un QR de verdad con el servicio real: un contenido inventado
  // moriría en la verificación de firma y no ejercitaría la transacción.
  async function qrDeCobro(creator, amount = 50) {
    const { generateQR } = await import('../../src/services/qrWalletService.js')
    const qr = await generateQR({
      type: 'charge', asset: 'BOB', creatorUserId: String(creator._id),
      creatorName: 'Juana Pérez', amount, description: 'cobro de prueba',
    })
    // Lo que viaja en el QR es el JSON del payload CON su firma, no un campo aparte.
    return JSON.stringify(qr.payload)
  }

  it('paga el QR: debita al pagador y acredita al cobrador', async () => {
    const cobrador = await crearUsuario()
    const pagador  = await crearUsuario()
    const wc = await bob(cobrador._id, { balance: 0 })
    const wp = await bob(pagador._id,  { balance: 500 })

    const res = resStub()
    await Q.scanAndPayQR(reqStub({ user: pagador, body: { qrContent: await qrDeCobro(cobrador, 50) } }), res)

    expect(res.code).toBe(200)
    expect((await WalletBOB.findById(wp._id)).balance).toBe(450)
    expect((await WalletBOB.findById(wc._id)).balance).toBe(50)
  })

  it('saldo insuficiente: 400 y nada escrito', async () => {
    const cobrador = await crearUsuario()
    const pagador  = await crearUsuario()
    const wc = await bob(cobrador._id, { balance: 0 })
    const wp = await bob(pagador._id,  { balance: 10 })

    const res = resStub()
    await Q.scanAndPayQR(reqStub({ user: pagador, body: { qrContent: await qrDeCobro(cobrador, 50) } }), res)

    expect(res.code).toBe(400)
    expect((await WalletBOB.findById(wp._id)).balance).toBe(10)
    expect((await WalletBOB.findById(wc._id)).balance).toBe(0)
    expect(await WalletTransaction.countDocuments({})).toBe(0)
  })

  it('el mismo QR de cobro no se paga dos veces: 409', async () => {
    const cobrador = await crearUsuario()
    const pagador  = await crearUsuario()
    await bob(cobrador._id, { balance: 0 })
    const wp = await bob(pagador._id, { balance: 500 })
    const contenido = await qrDeCobro(cobrador, 50)

    await Q.scanAndPayQR(reqStub({ user: pagador, body: { qrContent: contenido } }), resStub())
    const res2 = resStub()
    await Q.scanAndPayQR(reqStub({ user: pagador, body: { qrContent: contenido } }), res2)

    expect(res2.code).toBe(409)
    expect((await WalletBOB.findById(wp._id)).balance).toBe(450)   // un solo cobro
  })

  it('pagarse a uno mismo: 400', async () => {
    const u = await crearUsuario()
    await bob(u._id, { balance: 500 })
    const res = resStub()
    await Q.scanAndPayQR(reqStub({ user: u, body: { qrContent: await qrDeCobro(u, 50) } }), res)
    expect(res.code).toBe(400)
  })

  it.each([
    ['sin contenido', {}, {}, 400],
    ['sin KYC',       { kycStatus: 'pending' }, { qrContent: 'x' }, 403],
    ['no SRL',        { legalEntity: 'LLC' },   { qrContent: 'x' }, 403],
    ['QR con firma inválida', {}, { qrContent: 'basura.no.firmada' }, 400],
  ])('%s → %i', async (_, over, body, esperado) => {
    const u = await crearUsuario(over)
    await bob(u._id, { balance: 500 })
    const res = resStub()
    await Q.scanAndPayQR(reqStub({ user: u, body }), res)
    expect(res.code).toBe(esperado)
  })
})

describe('USDC→BOB y QR: reintento y carrera', () => {
  it('confirmar USDC→BOB perdiendo la carrera: 409, sin debitar ni acreditar', async () => {
    const u     = await crearUsuario()
    const admin = await crearUsuario()
    const wu = await usdc(u._id, { balance: 100, balanceReserved: 40 })
    const wb = await bob(u._id,  { balance: 200 })
    const wtx = await WalletTransaction.create({
      walletId: wu._id, userId: u._id, type: 'usdc_to_bob', currency: 'USDC',
      walletModel: 'WalletUSDC', amount: 40, status: 'pending',
      balanceBefore: 100, balanceAfter: 100,
      metadata: {
        usdcAmount: 40, bobAmount: 400, walletUSDCId: String(wu._id),
        walletBOBId: String(wb._id), bobPerUsdc: 10, marketRate: 10, spreadPct: 0,
      },
    })
    jest.spyOn(WalletTransaction, 'updateOne').mockResolvedValue({ modifiedCount: 0 })

    const res = resStub()
    await U.adminConfirmUSDCtoBOB(reqStub({ user: admin, body: { wtxId: wtx.wtxId } }), res)

    expect(res.code).toBe(409)
    expect((await WalletUSDC.findById(wu._id)).balance).toBe(100)
    expect((await WalletBOB.findById(wb._id)).balance).toBe(200)
  })

  it('pago por QR: si el débito condicional no entra, NO acredita al cobrador', async () => {
    const cobrador = await crearUsuario()
    const pagador  = await crearUsuario()
    const wc = await bob(cobrador._id, { balance: 0 })
    const wp = await bob(pagador._id,  { balance: 500 })

    const { generateQR } = await import('../../src/services/qrWalletService.js')
    const qr = await generateQR({
      type: 'charge', asset: 'BOB', creatorUserId: String(cobrador._id),
      creatorName: 'Juana Pérez', amount: 50, description: 'cobro',
    })

    // Simula que otro pago ganó la carrera y dejó el saldo sin alcanzar.
    jest.spyOn(WalletBOB, 'updateOne').mockResolvedValue({ modifiedCount: 0 })

    const res = resStub()
    await Q.scanAndPayQR(reqStub({ user: pagador, body: { qrContent: JSON.stringify(qr.payload) } }), res)

    expect(res.code).toBe(400)
    jest.restoreAllMocks()
    expect((await WalletBOB.findById(wp._id)).balance).toBe(500)
    expect((await WalletBOB.findById(wc._id)).balance).toBe(0)
    expect(await WalletTransaction.countDocuments({})).toBe(0)
  })

  it('pago por QR: un fallo transitorio se reintenta y cobra UNA sola vez', async () => {
    const cobrador = await crearUsuario()
    const pagador  = await crearUsuario()
    const wc = await bob(cobrador._id, { balance: 0 })
    const wp = await bob(pagador._id,  { balance: 500 })

    const { generateQR } = await import('../../src/services/qrWalletService.js')
    const qr = await generateQR({
      type: 'charge', asset: 'BOB', creatorUserId: String(cobrador._id),
      creatorName: 'Juana Pérez', amount: 50, description: 'cobro',
    })

    const c = fallarUnaVez(WalletTransaction, 'create')

    const res = resStub()
    await Q.scanAndPayQR(reqStub({ user: pagador, body: { qrContent: JSON.stringify(qr.payload) } }), res)

    expect(res.code).toBe(200)
    expect(c.intentos).toBeGreaterThan(1)
    expect((await WalletBOB.findById(wp._id)).balance).toBe(450)   // 50 una vez
    expect((await WalletBOB.findById(wc._id)).balance).toBe(50)
    expect(await WalletTransaction.countDocuments({ type: 'send' })).toBe(1)
  })
})

// ─── 9. cancelExpiredSep24 ────────────────────────────────────────────────────

describe('cancelExpiredSep24', () => {
  it.each([
    ['lista vacía',      { transactionIds: [],       reason: 'cierre administrativo de prueba' }],
    ['más de 100',       { transactionIds: Array(101).fill('x'), reason: 'cierre administrativo de prueba' }],
    ['motivo corto',     { transactionIds: ['x'],    reason: 'corto' }],
    ['sin motivo',       { transactionIds: ['x'] }],
  ])('%s → 400', async (_, body) => {
    const admin = await crearUsuario()
    const res = resStub()
    await A.cancelExpiredSep24(reqStub({ user: admin, body }), res)
    expect(res.code).toBe(400)
  })

  // ── Alcance real de esta prueba, para no engañar a quien la lea ────────────
  //
  // Verifica que un fallo transitorio se reintente y deje UNA sola entrada. Eso
  // sí lo cubre.
  //
  // Lo que NO cubre: el motivo por el que el `results.push` se sacó del callback.
  // Ese duplicado solo ocurre si el callback corre completo y después falla el
  // COMMIT, porque entonces `withTransaction` repite el callback entero. Acá el
  // fallo se inyecta en la primera escritura, así que el push nunca se alcanza en
  // el primer intento.
  //
  // Se intentó simular el fallo de commit parcheando `commitTransaction` en la
  // sesión y no funciona: el driver no reintenta a través de ese método público.
  // Dejar el push afuera queda entonces como medida defensiva SIN prueba que
  // demuestre el defecto original. Si alguien lo vuelve a meter adentro, esta
  // prueba no lo va a detectar.
  it('un reintento NO duplica la entrada en el resultado', async () => {
    const Transaction = (await import('../../src/models/Transaction.js')).default
    await Transaction.createCollection().catch(() => {})
    await Transaction.init()
    await Transaction.deleteMany({})

    const admin = await crearUsuario()
    const tx = await Transaction.create({
      alytoTransactionId: `ALY-S-${Date.now()}`,
      userId:         admin._id,
      legalEntity:    'SRL',
      operationType:  'crossBorderPayment',
      originCurrency: 'BOB',
      originalAmount: 100,
      status:         'sep24_deposit_pending',
      sep24Type:      'deposit',
      expiresAt:      new Date(Date.now() - 86_400_000),   // caducada ayer
      ipnLog:         [],
    })

    const c = fallarUnaVez(Transaction, 'findOneAndUpdate')

    const res = resStub()
    await A.cancelExpiredSep24(reqStub({
      user: admin,
      body: { transactionIds: [tx.alytoTransactionId], reason: 'cierre administrativo de instrucción caducada' },
    }), res)

    expect(res.code).toBe(200)
    expect(c.intentos).toBeGreaterThan(1)          // se reintentó de verdad
    expect(res.body.results).toHaveLength(1)       // UNA entrada, no una por intento
    expect(res.body.results[0].outcome).toBe('cancelled')
    expect(res.body.cancelled).toBe(1)
    expect((await Transaction.findById(tx._id)).status).toBe('cancelled')

    await Transaction.deleteMany({})
  })

  it('un identificador que no existe se reporta como not_found, sin fallar la llamada', async () => {
    const admin = await crearUsuario()
    const res = resStub()

    await A.cancelExpiredSep24(reqStub({
      user: admin, body: { transactionIds: ['ALY-NO-EXISTE'], reason: 'cierre administrativo de prueba' },
    }), res)

    expect(res.code).toBe(200)
    expect(res.body.cancelled).toBe(0)
    expect(res.body.results[0].outcome).toBe('not_found')
  })
})
