/**
 * reconcileBankDisbursements.test.js — Red de seguridad del dinero saliente.
 *
 * Este job corre sobre retiros donde el dinero YA fue ordenado al banco y el
 * saldo del usuario sigue reservado. Equivocarse acá tiene dos formas:
 *
 *   - completar un retiro que el banco nunca pagó (el usuario pierde el saldo)
 *   - dejar colgado uno que sí se pagó (el saldo queda reservado para siempre)
 *
 * Lo que se protege es que la decisión salga SIEMPRE de la respuesta del banco,
 * nunca de una inferencia por antigüedad, y que lo que el banco no resuelve
 * termine en manos de una persona.
 */

import { jest } from '@jest/globals'
import '../setup.env.js'
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js'

// La liquidación en sí (debitar saldo, liberar reserva) es responsabilidad de
// `walletController` y se prueba allá. Lo que importa acá es que el job DELEGUE
// bien: con el estado correcto, los datos correctos, y que mire el resultado.
// Se intercepta para poder forzar la respuesta sin depender de transacciones de
// MongoDB, que el servidor en memoria no soporta.
const settleSpy = jest.fn(async () => ({ ok: true, status: 'completed' }))
await jest.unstable_mockModule('../../src/controllers/walletController.js', () => ({
  settleDispatchedWithdrawal: settleSpy,
}))

let job, WalletTransaction, WalletBOB, ProviderReference, registry

beforeAll(async () => {
  await connectTestDb()
  job               = await import('../../src/jobs/reconcileBecDisbursements.js')
  WalletTransaction = (await import('../../src/models/WalletTransaction.js')).default
  WalletBOB         = (await import('../../src/models/WalletBOB.js')).default
  ProviderReference = (await import('../../src/models/ProviderReference.js')).default
  registry          = await import('../../src/services/bank/bankRegistry.js')
})

afterEach(async () => { jest.restoreAllMocks(); settleSpy.mockReset(); settleSpy.mockResolvedValue({ ok: true, status: 'completed' }); await clearCollections() })
afterAll(async () => { await disconnectTestDb() })

const HACE_DOS_HORAS = () => new Date(Date.now() - 2 * 60 * 60 * 1000)

/** Retiro despachado hace rato y sin confirmar, con su alias y processId. */
async function retiroAtascado({ provider = 'redenlace', conProcessId = true } = {}) {
  const wallet = await WalletBOB.create({ userId: '507f1f77bcf86cd799439011', balance: 100, balanceReserved: 50 })
  const wtx = await WalletTransaction.create({
    walletId: wallet._id, userId: wallet.userId,
    type: 'withdrawal', amount: 50, balanceBefore: 100, balanceAfter: 100,
    status: 'dispatched', currency: 'BOB', description: 'retiro',
    metadata: { method: 'bank', disbursementProvider: provider, dispatchedAt: HACE_DOS_HORAS(), bankBatchId: 'L1' },
  })
  await ProviderReference.create({
    provider, kind: 'payout', reference: '100000001',
    targetModel: 'WalletTransaction', targetId: wtx.wtxId,
    amount: 50, currency: 'BOB',
    meta: conProcessId ? { processId: 'uuid-del-lote', nroLote: 'L1' } : {},
  })
  return { wtx, wallet }
}

/** Fija qué va a responder el banco al consultarle el estado. */
function bancoResponde(estado, extra = {}) {
  const real = registry.getDisbursementAdapter('redenlace')
  jest.spyOn(real.disbursement, 'getBatchStatus').mockResolvedValue(
    estado === null ? null : { estado, mensaje: 'x', numeroAch: 'ACH-1', ...extra },
  )
  return real
}

describe('resolución por consulta al banco', () => {
  test('un retiro que el banco dice PAGADO se liquida como aceptado', async () => {
    const { wtx } = await retiroAtascado()
    bancoResponde('PAGADO')

    await job.reconcileBankDisbursements()

    expect(settleSpy).toHaveBeenCalledWith(wtx.wtxId, expect.objectContaining({
      accepted: true, bankReference: 'ACH-1',
    }))
    // Resuelto por el banco: no se molesta a nadie.
    expect((await WalletTransaction.findById(wtx._id)).metadata.disbursementAlertedAt).toBeUndefined()
  })

  test('un retiro RECHAZADO se liquida como rechazado, no como aceptado', async () => {
    const { wtx } = await retiroAtascado()
    bancoResponde('RECHAZADO')

    await job.reconcileBankDisbursements()

    // Invertir esto debitaría el saldo de un retiro que el banco nunca pagó.
    expect(settleSpy).toHaveBeenCalledWith(wtx.wtxId, expect.objectContaining({ accepted: false }))
  })

  test.each(['PROCESO', 'ENVIADO', 'PENDIENTE_CONFIRMACION'])(
    'un retiro en %s se deja correr: no se resuelve ni se alerta', async (estado) => {
      const { wtx } = await retiroAtascado()
      bancoResponde(estado)

      await job.reconcileBankDisbursements()

      expect(settleSpy).not.toHaveBeenCalled()
      const final = await WalletTransaction.findById(wtx._id)
      expect(final.status).toBe('dispatched')
      expect(final.metadata.disbursementAlertedAt).toBeUndefined()
    })
})

describe('lo que no se resuelve solo', () => {
  // Un retiro pagado que volvió. El saldo del usuario ya se debitó y
  // reacreditarlo es una decisión de producto que no está tomada.
  test('REVERTIDO va siempre a una persona', async () => {
    const { wtx } = await retiroAtascado()
    bancoResponde('REVERTIDO')

    await job.reconcileBankDisbursements()

    // Lo peligroso sería liquidarlo: ni aceptado ni rechazado describe una devolución.
    expect(settleSpy).not.toHaveBeenCalled()
    const final = await WalletTransaction.findById(wtx._id)
    expect(final.status).toBe('dispatched')
    expect(final.metadata.disbursementAlertedAt).toBeDefined()
    expect(final.metadata.disbursementStuckReason).toMatch(/REVERTIDO/)
  })

  test('un proveedor que no sabe responder estado solo alerta, nunca infiere', async () => {
    // BANECO: sin consulta de estado. Completar por antigüedad sería inventar
    // que el banco pagó.
    const { wtx } = await retiroAtascado({ provider: 'baneco' })

    await job.reconcileBankDisbursements()

    const final = await WalletTransaction.findById(wtx._id)
    expect(final.status).toBe('dispatched')
    expect(final.metadata.disbursementStuckReason).toMatch(/no permite consultar/)
  })

  test('sin processId guardado no hay consulta posible, así que alerta', async () => {
    const { wtx } = await retiroAtascado({ conProcessId: false })

    await job.reconcileBankDisbursements()

    const final = await WalletTransaction.findById(wtx._id)
    expect(final.metadata.disbursementStuckReason).toMatch(/processId/)
  })

  // `settleDispatchedWithdrawal` NO lanza ante un fallo: devuelve {ok:false}.
  // Darlo por resuelto sin mirar ese campo dejaba el retiro colgado, sin
  // reintento y sin alerta, que es la peor combinación con el dinero ya fuera
  // del banco. Era un defecto real: lo encontró el entorno de prueba.
  test('si la liquidación falla, no se da por resuelto', async () => {
    const { wtx } = await retiroAtascado()
    bancoResponde('PAGADO')
    settleSpy.mockResolvedValue({ ok: false, reason: 'not-found' })

    await job.reconcileBankDisbursements()

    const final = await WalletTransaction.findById(wtx._id)
    expect(final.metadata.disbursementAlertedAt).toBeDefined()
    expect(final.metadata.disbursementStuckReason).toMatch(/liquidación falló/)
  })

  test('un banco caído se reintenta, no se reporta como retiro perdido', async () => {
    const { wtx } = await retiroAtascado()
    const real = registry.getDisbursementAdapter('redenlace')
    jest.spyOn(real.disbursement, 'getBatchStatus').mockRejectedValue(new Error('HTTP 503'))

    await job.reconcileBankDisbursements()

    const final = await WalletTransaction.findById(wtx._id)
    // Sin marca de alerta: la próxima corrida vuelve a intentar.
    expect(final.metadata.disbursementAlertedAt).toBeUndefined()
    expect(final.status).toBe('dispatched')
  })
})

describe('alcance del barrido', () => {
  test('no toca retiros recién despachados', async () => {
    const wallet = await WalletBOB.create({ userId: '507f1f77bcf86cd799439011', balance: 100, balanceReserved: 50 })
    const wtx = await WalletTransaction.create({
      walletId: wallet._id, userId: wallet.userId,
      type: 'withdrawal', amount: 50, balanceBefore: 100, balanceAfter: 100,
      status: 'dispatched', currency: 'BOB', description: 'recién despachado',
      metadata: { disbursementProvider: 'redenlace', dispatchedAt: new Date() },
    })
    const spy = bancoResponde('PAGADO')

    await job.reconcileBankDisbursements()

    expect(spy.disbursement.getBatchStatus).not.toHaveBeenCalled()
    expect((await WalletTransaction.findById(wtx._id)).status).toBe('dispatched')
  })

  test('no vuelve a alertar sobre un retiro ya alertado', async () => {
    const { wtx } = await retiroAtascado({ provider: 'baneco' })
    await WalletTransaction.updateOne({ _id: wtx._id }, { $set: { 'metadata.disbursementAlertedAt': new Date() } })

    await job.reconcileBankDisbursements()

    // Sigue con la marca original: no se duplicó el aviso.
    expect((await WalletTransaction.findById(wtx._id)).metadata.disbursementStuckReason).toBeUndefined()
  })

  test('el alias histórico sigue apuntando al mismo job', () => {
    // Es el nombre cableado en app.js, jobRegistry.js y EventBridge.
    expect(job.reconcileBecDisbursements).toBe(job.reconcileBankDisbursements)
  })
})
