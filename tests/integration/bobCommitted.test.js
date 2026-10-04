/**
 * bobCommitted.test.js — BOB comprometido (respaldo bancario que no es de las wallets)
 *
 * El efectivo de la cuenta bancaria respalda DOS pasivos, no uno: los saldos de las
 * wallets y los pagos transfronterizos ya cobrados que todavía no se ejecutaron ni se
 * devolvieron. Antes solo se reconocía el primero, así que la cobertura BOB se leía
 * mejor de lo que era — y se leía mejor en la dirección que favorece a la empresa.
 *
 * Lo que estas pruebas protegen, en orden de qué tan caro es romperlo:
 *
 *   1. Una operación FALLIDA con el dinero cobrado sigue siendo un pasivo. Si se la
 *      deja fuera, el efectivo que se le debe al usuario aparece como respaldo libre
 *      y se barre a fondeo de tesorería sin que nadie lo note. Ese es el agujero.
 *   2. Un QR que venció sin que nadie pagara NO es un pasivo, y marca 'failed' igual
 *      que el rechazo del proveedor. El estado por sí solo no alcanza: hace falta
 *      evidencia de cobro.
 *   3. 'refunded' ya se acreditó a WalletBOB, así que contarlo aquí lo contaría dos
 *      veces contra el mismo efectivo.
 */

import '../setup.env.js'
import mongoose from 'mongoose'
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js'

let Transaction
let getBOBCommitted

beforeAll(async () => {
  await connectTestDb()
  Transaction      = (await import('../../src/models/Transaction.js')).default
  getBOBCommitted  = (await import('../../src/services/treasuryLiquidity.js')).getBOBCommitted
})
afterEach(async () => { await clearCollections() })
afterAll(async () => { await disconnectTestDb() })

let seq = 0

/** Transacción BOB de la SRL con lo mínimo que el esquema exige. */
async function txBOB({ status, amount, paidAt, confirmedAt, refundWtxId, originCurrency = 'BOB', legalEntity = 'SRL' }) {
  seq += 1
  return Transaction.create({
    alytoTransactionId: `ALY-C-TEST-${seq}`,
    operationType:      'crossBorderPayment',
    userId:             new mongoose.Types.ObjectId(),
    legalEntity,
    originalAmount:     amount,
    originCurrency,
    destinationCurrency: 'USD',
    status,
    ...(paidAt      ? { bankQr: { bankId: 'bec', qrId: `qr-${seq}`, paidAt } } : {}),
    ...(confirmedAt ? { confirmationDetails: { confirmedAt } } : {}),
    ...(refundWtxId ? { refund: { wtxId: refundWtxId, method: 'walletBOB' } } : {}),
  })
}

describe('operaciones en curso', () => {
  test('el payin confirmado compromete el efectivo', async () => {
    await txBOB({ status: 'payin_confirmed', amount: 1000, paidAt: new Date() })
    await txBOB({ status: 'payout_sent',     amount: 500,  paidAt: new Date() })

    const r = await getBOBCommitted('SRL')
    expect(r.committed).toBe(1500)
    expect(r.inProgress).toBe(1500)
    expect(r.refundDue).toBe(0)
    expect(r.operations).toBe(2)
  })

  test('los estados posteriores al payin cuentan sin necesitar evidencia de cobro', async () => {
    // pending_funding solo se alcanza con el payin ya confirmado: el estado ES la prueba.
    await txBOB({ status: 'pending_funding', amount: 800 })

    const r = await getBOBCommitted('SRL')
    expect(r.committed).toBe(800)
  })

  test('un QR emitido y no pagado todavía no compromete nada', async () => {
    await txBOB({ status: 'payin_pending', amount: 2000 })

    const r = await getBOBCommitted('SRL')
    expect(r.committed).toBe(0)
    expect(r.operations).toBe(0)
  })
})

describe('operaciones fallidas: el agujero que esto cierra', () => {
  test('el rechazo del proveedor con el dinero cobrado se le debe al usuario', async () => {
    await txBOB({ status: 'failed', amount: 1200, paidAt: new Date() })

    const r = await getBOBCommitted('SRL')
    expect(r.committed).toBe(1200)
    expect(r.refundDue).toBe(1200)
    expect(r.inProgress).toBe(0)
  })

  test('el payin manual confirmado por admin cuenta igual que el QR', async () => {
    await txBOB({ status: 'failed', amount: 700, confirmedAt: new Date() })

    const r = await getBOBCommitted('SRL')
    expect(r.refundDue).toBe(700)
  })

  test('el QR vencido sin pagar NO se le debe a nadie, aunque esté en failed', async () => {
    // Mismo estado que el rechazo del proveedor, sin bankQr.paidAt: nunca entró dinero.
    await txBOB({ status: 'failed', amount: 3000 })

    const r = await getBOBCommitted('SRL')
    expect(r.committed).toBe(0)
    expect(r.refundDue).toBe(0)
  })

  test('separa lo debido de lo en curso en el mismo total', async () => {
    await txBOB({ status: 'failed',          amount: 400, paidAt: new Date() })
    await txBOB({ status: 'payin_confirmed', amount: 600, paidAt: new Date() })

    const r = await getBOBCommitted('SRL')
    expect(r.committed).toBe(1000)
    expect(r.refundDue).toBe(400)
    expect(r.inProgress).toBe(600)
  })
})

describe('estados que liberan el efectivo', () => {
  test('completed no compromete: el efectivo cubre el USDC que ya salió', async () => {
    await txBOB({ status: 'completed', amount: 5000, paidAt: new Date() })

    const r = await getBOBCommitted('SRL')
    expect(r.committed).toBe(0)
  })

  test('refunded CON evidencia no compromete: se cuenta del otro lado', async () => {
    // Si contara aquí, el mismo efectivo respaldaría dos pasivos a la vez.
    await txBOB({ status: 'refunded', amount: 900, paidAt: new Date(), refundWtxId: 'WTX-1' })

    const r = await getBOBCommitted('SRL')
    expect(r.committed).toBe(0)
    expect(r.refundedUnproven).toBe(0)
  })

  test('refunded SIN evidencia sigue siendo pasivo', async () => {
    // Existe en producción: ALY-C-1786548682442-NE1YVC, Bs 236, cobrado, marcado
    // 'refunded', cero movimientos de wallet. La etiqueta se pone a mano desde el
    // panel sin mover dinero, así que por sí sola no libera nada.
    await txBOB({ status: 'refunded', amount: 236, paidAt: new Date() })

    const r = await getBOBCommitted('SRL')
    expect(r.committed).toBe(236)
    expect(r.refundedUnproven).toBe(236)
    // No es un reembolso debido por fallo: es uno que se afirmó sin ejecutar.
    expect(r.refundDue).toBe(0)
    expect(r.inProgress).toBe(0)
  })

  test('el reembolso es neutro: lo que sale de comprometido entra al saldo', async () => {
    const tx = await txBOB({ status: 'failed', amount: 1000, paidAt: new Date() })
    expect((await getBOBCommitted('SRL')).committed).toBe(1000)

    // Simula lo que hará el motor de reembolso: terminal 'refunded' + el wtxId del
    // crédito a WalletBOB como prueba de que el dinero efectivamente se movió.
    await Transaction.updateOne(
      { _id: tx._id },
      { status: 'refunded', 'refund.wtxId': 'WTX-REEMBOLSO-1', 'refund.method': 'walletBOB' },
    )

    // El comprometido baja exactamente el monto que la wallet va a subir → el respaldo
    // total requerido no se mueve. Esa es la invariante que vuelve defendible el reembolso.
    expect((await getBOBCommitted('SRL')).committed).toBe(0)
  })

  test('marcar refunded a mano, sin crédito, NO libera el pasivo', async () => {
    const tx = await txBOB({ status: 'failed', amount: 1000, paidAt: new Date() })

    // Exactamente lo que hoy permite PATCH /admin/transactions/:id/status.
    await Transaction.updateOne({ _id: tx._id }, { status: 'refunded' })

    const r = await getBOBCommitted('SRL')
    expect(r.committed).toBe(1000)
    expect(r.refundedUnproven).toBe(1000)
  })
})

describe('alcance del cálculo', () => {
  test('ignora monedas de origen distintas de BOB', async () => {
    await txBOB({ status: 'payin_confirmed', amount: 50000, originCurrency: 'CLP' })

    const r = await getBOBCommitted('SRL')
    expect(r.committed).toBe(0)
  })

  test('ignora otras entidades legales', async () => {
    await txBOB({ status: 'payin_confirmed', amount: 1000, legalEntity: 'LLC', paidAt: new Date() })

    expect((await getBOBCommitted('SRL')).committed).toBe(0)
    expect((await getBOBCommitted('LLC')).committed).toBe(1000)
  })

  test('sin operaciones devuelve ceros, no null', async () => {
    const r = await getBOBCommitted('SRL')
    expect(r).toEqual({ committed: 0, operations: 0, inProgress: 0, refundDue: 0, refundedUnproven: 0 })
  })
})
