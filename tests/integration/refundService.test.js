/**
 * refundService.test.js — Que una devolución devuelva dinero, y que el pasivo
 * se libere solo cuando eso es cierto.
 *
 * Hasta ahora la devolución era una etiqueta: un admin forzaba
 * `status:'refunded'` y nada se movía. En producción hay exactamente un registro
 * así. Lo que se prueba acá es que eso no pueda volver a pasar, y sobre todo la
 * regla contable que lo evita:
 *
 *   `refund.wtxId` se escribe SOLO cuando el dinero se movió de verdad.
 *
 * Por eso varias pruebas verifican el pasivo con `getBOBCommitted`, que es el
 * número real que mira la solvencia, en vez de conformarse con el estado del
 * documento. Una devolución bancaria en vuelo DEBE seguir contando como pasivo:
 * todavía puede rechazarse.
 *
 * Levanta un replica set propio porque el crédito a billetera es atómico
 * (movimiento y evidencia, o ninguno) y eso exige transacciones, que el servidor
 * en memoria de un solo nodo no soporta.
 */

import { jest } from '@jest/globals'
import '../setup.env.js'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { MongoServerError } from 'mongodb'

// El riel bancario se intercepta: lo que importa es la coreografía y la
// contabilidad, no ATC. El servicio compartido de dispersión sí corre de verdad.
const transferSpy = jest.fn(async () => ({ bankBatchId: 'lote-dev-1', reference: '100000777' }))

await jest.unstable_mockModule('../../src/services/bank/bankRegistry.js', () => ({
  getDisbursementAdapter: () => ({
    provider:     'redenlace',
    adapter:      {},
    disbursement: { transfer: transferSpy },
  }),
}))

let rs
let Transaction, WalletTransaction, WalletBOB
let executeRefund, settleDispatchedRefund, REFUND_METHODS, getBOBCommitted

beforeAll(async () => {
  // `maxTransactionLockRequestTimeoutMillis` por defecto es 5 ms, y con eso una
  // transacción que escribe dos colecciones recién sembradas falla por bloqueo.
  // No es un problema del código: en producción el límite es el del servidor y
  // las colecciones ya existen.
  rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ args: ['--setParameter', 'maxTransactionLockRequestTimeoutMillis=5000'] }],
  })
  await mongoose.connect(rs.getUri(), { dbName: 'refundtest' })

  Transaction       = (await import('../../src/models/Transaction.js')).default
  WalletTransaction = (await import('../../src/models/WalletTransaction.js')).default
  WalletBOB         = (await import('../../src/models/WalletBOB.js')).default

  const svc = await import('../../src/services/refundService.js')
  executeRefund          = svc.executeRefund
  settleDispatchedRefund = svc.settleDispatchedRefund
  REFUND_METHODS         = svc.REFUND_METHODS

  getBOBCommitted = (await import('../../src/services/treasuryLiquidity.js')).getBOBCommitted

  // Dos cosas que en producción ya están hechas y acá hay que adelantar, porque
  // ambas abortan una transacción si ocurren dentro de ella: la creación de la
  // colección (WriteConflict) y la construcción de índices ("catalog changes").
  for (const M of [Transaction, WalletTransaction, WalletBOB]) {
    await M.createCollection().catch(() => {})
    await M.init()
  }
}, 180_000)

afterAll(async () => {
  await mongoose.disconnect()
  await rs?.stop()
})

const userId = new mongoose.Types.ObjectId()

/** Operación cobrada en bolivianos que no se ejecutó: el caso de una devolución. */
async function sembrarOperacion(extra = {}) {
  return Transaction.create({
    alytoTransactionId: `ALY-C-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    userId,
    legalEntity:    'SRL',
    operationType:  'crossBorderPayment',
    originCurrency: 'BOB',
    originalAmount: 500,
    status:         'failed',
    bankQr:         { paidAt: new Date() },
    ...extra,
  })
}

async function sembrarBilletera(balance = 100) {
  return WalletBOB.create({ userId, balance, currency: 'BOB' })
}

const CUENTA = { accountNumber: '1311404044', bankCode: '1018', accountHolder: 'Juana Pérez', docId: '1234567' }
const MOTIVO = 'el corredor rechazó el payout y el dinero quedó adentro'

beforeEach(async () => {
  transferSpy.mockClear()
  transferSpy.mockResolvedValue({ bankBatchId: 'lote-dev-1', reference: '100000777' })
  await Promise.all([
    Transaction.deleteMany({}), WalletTransaction.deleteMany({}), WalletBOB.deleteMany({}),
  ])
})

describe('devolución a la billetera', () => {
  it('acredita el saldo y deja la evidencia en el mismo movimiento', async () => {
    const tx = await sembrarOperacion()
    const w  = await sembrarBilletera(100)

    const r = await executeRefund({ transactionId: tx.alytoTransactionId, reason: MOTIVO })

    expect(r).toMatchObject({ ok: true, method: 'walletBOB', state: 'settled' })
    expect((await WalletBOB.findById(w._id)).balance).toBe(600)

    const fresca = await Transaction.findById(tx._id)
    expect(fresca.status).toBe('refunded')
    expect(fresca.refund.wtxId).toBe(r.wtxId)
    expect(fresca.refund.amount).toBe(500)
  })

  it('el movimiento es de tipo refund, no deposit: no es captación nueva', async () => {
    const tx = await sembrarOperacion()
    await sembrarBilletera()

    const r = await executeRefund({ transactionId: tx.alytoTransactionId, reason: MOTIVO })
    const wtx = await WalletTransaction.findOne({ wtxId: r.wtxId })

    expect(wtx.type).toBe('refund')
    expect(wtx.status).toBe('completed')
  })

  it('libera el pasivo: era Bs 500 comprometidos y queda en cero', async () => {
    const tx = await sembrarOperacion()
    await sembrarBilletera()

    const antes = await getBOBCommitted('SRL')
    expect(antes.committed).toBe(500)

    await executeRefund({ transactionId: tx.alytoTransactionId, reason: MOTIVO })

    const despues = await getBOBCommitted('SRL')
    expect(despues.committed).toBe(0)
  })

  it('llamarla dos veces no acredita dos veces', async () => {
    const tx = await sembrarOperacion()
    const w  = await sembrarBilletera(0)

    const primera = await executeRefund({ transactionId: tx.alytoTransactionId, reason: MOTIVO })
    const segunda = await executeRefund({ transactionId: tx.alytoTransactionId, reason: MOTIVO })

    expect(segunda).toMatchObject({ ok: true, state: 'already', wtxId: primera.wtxId })
    expect((await WalletBOB.findById(w._id)).balance).toBe(500)
    expect(await WalletTransaction.countDocuments({ type: 'refund' })).toBe(1)
  })

  it('crea la billetera si el usuario no tenía: el dinero es suyo', async () => {
    // No puede fallar porque nunca abrió billetera. Ya había entregado el dinero.
    const tx = await sembrarOperacion()
    expect(await WalletBOB.countDocuments({ userId })).toBe(0)

    const r = await executeRefund({ transactionId: tx.alytoTransactionId, reason: MOTIVO })

    expect(r).toMatchObject({ ok: true, state: 'settled' })
    expect((await WalletBOB.findOne({ userId })).balance).toBe(500)
  })
})

describe('transacciones: reintento y aborto', () => {
  // Estas dos cubren el cambio de `startTransaction` manual a `withTransaction`.
  // El riesgo del cambio es que ahí retornar hace commit: para abortar hay que
  // lanzar. Si alguien vuelve a poner un `return`, la segunda prueba falla.
  afterEach(() => jest.restoreAllMocks())

  it('un fallo transitorio de MongoDB se reintenta en vez de perder la devolución', async () => {
    const tx = await sembrarOperacion()
    await sembrarBilletera(100)

    const real = WalletBOB.updateOne.bind(WalletBOB)
    let intentos = 0
    jest.spyOn(WalletBOB, 'updateOne').mockImplementation((...args) => {
      if (++intentos === 1) {
        // Tiene que ser un error del driver, no un Error pelado con la etiqueta
        // puesta: `withTransaction` exige `instanceof MongoError` antes de mirar
        // las etiquetas, así que un impostor no se reintenta.
        const err = new MongoServerError({ message: 'conflicto de escritura simulado' })
        err.addErrorLabel('TransientTransactionError')
        throw err
      }
      return real(...args)
    })

    const r = await executeRefund({ transactionId: tx.alytoTransactionId, reason: MOTIVO })

    expect(r).toMatchObject({ ok: true, state: 'settled' })
    expect(intentos).toBeGreaterThan(1)
    expect((await WalletBOB.findOne({ userId })).balance).toBe(600)
    // El reintento no puede dejar dos movimientos ni acreditar dos veces.
    expect(await WalletTransaction.countDocuments({ type: 'refund' })).toBe(1)
  })

  it('si pierde la carrera por la evidencia, NO acredita el saldo', async () => {
    const tx = await sembrarOperacion()
    await sembrarBilletera(100)

    // Simula que otra devolución escribió la evidencia justo antes del guard.
    jest.spyOn(Transaction, 'updateOne').mockResolvedValue({ modifiedCount: 0 })

    const r = await executeRefund({ transactionId: tx.alytoTransactionId, reason: MOTIVO })

    expect(r).toMatchObject({ ok: false, code: 'race' })
    // Lo que importa: el crédito y el movimiento se descartaron con el aborto.
    expect((await WalletBOB.findOne({ userId })).balance).toBe(100)
    expect(await WalletTransaction.countDocuments({ type: 'refund' })).toBe(0)
  })
})

describe('qué se niega a devolver', () => {
  it('una operación completada: el servicio se prestó', async () => {
    const tx = await sembrarOperacion({ status: 'completed' })
    await sembrarBilletera()

    const r = await executeRefund({ transactionId: tx.alytoTransactionId, reason: MOTIVO })
    expect(r.code).toBe('not_refundable')
  })

  it('una operación sin evidencia de cobro: no hay nada que devolver', async () => {
    const tx = await sembrarOperacion({ status: 'payin_pending', bankQr: undefined })
    await sembrarBilletera()

    const r = await executeRefund({ transactionId: tx.alytoTransactionId, reason: MOTIVO })
    expect(r.code).toBe('not_refundable')
    expect(await WalletTransaction.countDocuments({})).toBe(0)
  })

  it('una cobrada en otra moneda', async () => {
    const tx = await sembrarOperacion({ originCurrency: 'CLP' })
    const r  = await executeRefund({ transactionId: tx.alytoTransactionId, reason: MOTIVO })
    expect(r.code).toBe('unsupported')
  })

  it('sin motivo, o con uno de relleno', async () => {
    const tx = await sembrarOperacion()
    expect((await executeRefund({ transactionId: tx.alytoTransactionId })).code).toBe('invalid_request')
    expect((await executeRefund({ transactionId: tx.alytoTransactionId, reason: 'ok' })).code).toBe('invalid_request')
  })

  it('una inexistente', async () => {
    expect((await executeRefund({ transactionId: 'ALY-NO-EXISTE', reason: MOTIVO })).code).toBe('not_found')
  })
})

describe('devolución por transferencia bancaria', () => {
  it('exige la cuenta destino y explica por qué no la tenemos', async () => {
    const tx = await sembrarOperacion()
    const r  = await executeRefund({
      transactionId: tx.alytoTransactionId, method: REFUND_METHODS.BANK, reason: MOTIVO,
    })

    expect(r.code).toBe('invalid_request')
    expect(r.reason).toMatch(/no revela la cuenta de quien pagó/)
    expect(transferSpy).not.toHaveBeenCalled()
  })

  it('ordena la transferencia y la deja en curso', async () => {
    const tx = await sembrarOperacion()
    const r  = await executeRefund({
      transactionId: tx.alytoTransactionId, method: REFUND_METHODS.BANK, reason: MOTIVO, bank: CUENTA,
    })

    expect(r).toMatchObject({ ok: true, method: 'bankTransfer', state: 'dispatched' })
    expect(transferSpy).toHaveBeenCalledTimes(1)
    expect((await WalletTransaction.findOne({ wtxId: r.wtxId })).status).toBe('dispatched')
  })

  it('NO toca el saldo de la billetera: el dinero va de banco a banco', async () => {
    const tx = await sembrarOperacion()
    const w  = await sembrarBilletera(100)

    await executeRefund({
      transactionId: tx.alytoTransactionId, method: REFUND_METHODS.BANK, reason: MOTIVO, bank: CUENTA,
    })

    expect((await WalletBOB.findById(w._id)).balance).toBe(100)
  })

  it('mientras está en vuelo el pasivo SIGUE reconocido', async () => {
    // Esta es la prueba que justifica todo el diseño. Una transferencia ordenada
    // todavía puede rechazarse; declararla devuelta sería afirmar algo que no
    // pasó, y del lado que favorece a la empresa.
    const tx = await sembrarOperacion()
    await executeRefund({
      transactionId: tx.alytoTransactionId, method: REFUND_METHODS.BANK, reason: MOTIVO, bank: CUENTA,
    })

    const fresca = await Transaction.findById(tx._id)
    expect(fresca.refund?.wtxId).toBeFalsy()

    const pasivo = await getBOBCommitted('SRL')
    expect(pasivo.committed).toBe(500)
  })

  it('no ordena una segunda transferencia si ya hay una en vuelo', async () => {
    const tx = await sembrarOperacion()
    await executeRefund({ transactionId: tx.alytoTransactionId, method: REFUND_METHODS.BANK, reason: MOTIVO, bank: CUENTA })

    const segunda = await executeRefund({ transactionId: tx.alytoTransactionId, method: REFUND_METHODS.BANK, reason: MOTIVO, bank: CUENTA })

    expect(segunda.code).toBe('in_flight')
    expect(transferSpy).toHaveBeenCalledTimes(1)
  })

  it('si el banco rechaza la orden, el registro no bloquea el próximo intento', async () => {
    transferSpy.mockRejectedValue(new Error('ciNitDestino es requerido'))
    const tx = await sembrarOperacion()

    const r = await executeRefund({ transactionId: tx.alytoTransactionId, method: REFUND_METHODS.BANK, reason: MOTIVO, bank: CUENTA })
    expect(r.ok).toBe(false)

    // El registro de seguimiento quedó cerrado, así que el guard de 'en vuelo'
    // no impide reintentar una vez corregido el dato.
    expect(await WalletTransaction.countDocuments({ status: { $in: ['pending', 'dispatched'] } })).toBe(0)

    transferSpy.mockResolvedValue({ bankBatchId: 'lote-2' })
    expect((await executeRefund({
      transactionId: tx.alytoTransactionId, method: REFUND_METHODS.BANK, reason: MOTIVO, bank: CUENTA,
    })).ok).toBe(true)
  })
})

describe('cierre de una devolución bancaria', () => {
  async function ordenar() {
    const tx = await sembrarOperacion()
    const r  = await executeRefund({
      transactionId: tx.alytoTransactionId, method: REFUND_METHODS.BANK, reason: MOTIVO, bank: CUENTA,
    })
    return { tx, wtxId: r.wtxId }
  }

  it('aceptada: escribe la evidencia y libera el pasivo', async () => {
    const { tx, wtxId } = await ordenar()

    const r = await settleDispatchedRefund(wtxId, { accepted: true, bankReference: 'ACH-998' })
    expect(r).toMatchObject({ ok: true, status: 'completed' })

    const fresca = await Transaction.findById(tx._id)
    expect(fresca.status).toBe('refunded')
    expect(fresca.refund.wtxId).toBe(wtxId)
    expect(fresca.refund.method).toBe('bankTransfer')

    expect((await getBOBCommitted('SRL')).committed).toBe(0)
  })

  it('aceptada: tampoco acá se toca el saldo', async () => {
    const w = await sembrarBilletera(100)
    const { wtxId } = await ordenar()

    await settleDispatchedRefund(wtxId, { accepted: true })
    expect((await WalletBOB.findById(w._id)).balance).toBe(100)
  })

  it('rechazada: no escribe evidencia y el pasivo queda en pie', async () => {
    const { tx, wtxId } = await ordenar()

    const r = await settleDispatchedRefund(wtxId, { accepted: false, reason: 'cuenta inexistente' })
    expect(r).toMatchObject({ ok: true, status: 'failed' })

    const fresca = await Transaction.findById(tx._id)
    expect(fresca.refund?.wtxId).toBeFalsy()
    expect((await getBOBCommitted('SRL')).committed).toBe(500)
  })

  it('el mismo webhook dos veces no duplica nada', async () => {
    const { wtxId } = await ordenar()

    await settleDispatchedRefund(wtxId, { accepted: true })
    const segunda = await settleDispatchedRefund(wtxId, { accepted: true })

    expect(segunda).toMatchObject({ ok: true, reason: 'already-settled' })
  })

  it('ignora un wtxId que no es una devolución', async () => {
    const ajeno = await WalletTransaction.create({
      walletId: new mongoose.Types.ObjectId(), userId, type: 'withdrawal',
      currency: 'BOB', walletModel: 'WalletBOB', amount: 10, status: 'dispatched',
      balanceBefore: 0, balanceAfter: 0,
    })
    expect(await settleDispatchedRefund(ajeno.wtxId, { accepted: true })).toMatchObject({ ok: false, reason: 'not-found' })
  })

  it('no cierra una que no fue ordenada al banco', async () => {
    const pend = await WalletTransaction.create({
      walletId: new mongoose.Types.ObjectId(), userId, type: 'refund',
      currency: 'BOB', walletModel: 'WalletBOB', amount: 10, status: 'pending',
      balanceBefore: 0, balanceAfter: 0,
    })
    expect((await settleDispatchedRefund(pend.wtxId, { accepted: true })).reason).toBe('bad-status-pending')
  })
})
