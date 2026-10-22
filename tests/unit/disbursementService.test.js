/**
 * disbursementService.test.js — La secuencia de una salida de bolivianos.
 *
 * El valor de este servicio no es que llame al banco: es el ORDEN en que hace
 * las cosas. Tres flujos distintos van a depender de él (retiro de billetera,
 * devolución, corredor Chile a Bolivia), y lo que se prueba acá es que ninguno
 * tenga que volver a derivar esa secuencia:
 *
 *   1. validar lo barato — sin tocar estado
 *   2. proveedor y liquidez
 *   3. claim atómico
 *   4. orden al banco
 *   5. revert solo si el banco falló
 *
 * La propiedad más importante es que el paso 1 ocurra ANTES del 3: un rechazo
 * por formato no debe dejar nada reclamado. El caso real que lo motiva es que
 * falte el documento del beneficiario, que Red Enlace exige y el frontend
 * todavía no captura.
 */

import { jest } from '@jest/globals'
import '../setup.env.js'

// Se intercepta el registro para controlar qué devuelve el adapter sin tocar
// credenciales ni red. Lo que se prueba es la coreografía, no el banco.
const transferSpy  = jest.fn(async () => ({ bankBatchId: 'lote-1', reference: '100000042' }))
const balanceSpy   = jest.fn(async () => ({ available: 10_000, ok: true }))
let   adapterPresente = true
let   adapterSinSaldo   = false   // simula Red Enlace: no sabe responder el saldo

await jest.unstable_mockModule('../../src/services/bank/bankRegistry.js', () => ({
  getDisbursementAdapter: (provider) => {
    if (!adapterPresente) return null
    return {
      provider: provider ?? 'redenlace',
      adapter:      adapterSinSaldo ? {} : { tryGetAvailableBalance: balanceSpy },
      disbursement: { transfer: transferSpy },
    }
  },
}))

const { orderPayout, PURPOSES, PAYOUT_ERRORS, httpStatusFor } =
  await import('../../src/services/bank/disbursementService.js')

/** Orden válida mínima. Cada prueba rompe un solo campo a la vez. */
const ordenValida = (extra = {}) => ({
  reference:   'WTX-1',
  targetModel: 'WalletTransaction',
  amount:      100,
  purpose:     PURPOSES.WALLET_WITHDRAWAL,
  description: 'Retiro Alyto WTX-1',
  beneficiary: { accountCode: '1311404044', bankCode: '1018', name: 'Juana Pérez', docId: '1234567' },
  amlData:     { source: 'Saldo en billetera', destination: 'Cuenta propia del titular' },
  ...extra,
})

beforeEach(() => {
  adapterPresente = true
  adapterSinSaldo = false
  transferSpy.mockClear()
  balanceSpy.mockClear()
  transferSpy.mockResolvedValue({ bankBatchId: 'lote-1', reference: '100000042' })
  balanceSpy.mockResolvedValue({ available: 10_000, ok: true })
  delete process.env.WALLET_BANK_LIQUIDITY_CHECK
  delete process.env.WALLET_BANECO_LIQUIDITY_CHECK
})

describe('camino feliz', () => {
  it('ordena al banco y devuelve el lote', async () => {
    const r = await orderPayout(ordenValida())
    expect(r).toMatchObject({ ok: true, provider: 'redenlace', bankBatchId: 'lote-1', mock: false })
    expect(transferSpy).toHaveBeenCalledTimes(1)
  })

  it('reclama antes de ordenar, no después', async () => {
    const orden = []
    transferSpy.mockImplementation(async () => { orden.push('transfer'); return { bankBatchId: 'x' } })

    await orderPayout(ordenValida({
      claim: async () => { orden.push('claim'); return true },
    }))

    expect(orden).toEqual(['claim', 'transfer'])
  })

  it('consulta liquidez antes de reclamar', async () => {
    process.env.WALLET_BANK_LIQUIDITY_CHECK = 'true'
    const orden = []
    balanceSpy.mockImplementation(async () => { orden.push('saldo'); return { available: 10_000, ok: true } })

    await orderPayout(ordenValida({
      claim: async () => { orden.push('claim'); return true },
    }))

    expect(orden).toEqual(['saldo', 'claim'])
  })

  it('le pasa al claim el proveedor resuelto, para que lo guarde en el mismo write', async () => {
    const claim = jest.fn(async () => true)
    await orderPayout(ordenValida({ provider: 'redenlace', claim }))
    expect(claim).toHaveBeenCalledWith({ provider: 'redenlace' })
  })

  it('propaga targetModel al adapter: una devolución no debe etiquetarse como retiro', async () => {
    await orderPayout(ordenValida({ targetModel: 'Transaction', purpose: PURPOSES.REFUND }))
    expect(transferSpy).toHaveBeenCalledWith(expect.objectContaining({ targetModel: 'Transaction' }))
  })

  it('marca mock cuando el adapter simula', async () => {
    transferSpy.mockResolvedValue({ bankBatchId: 'mock-1', _mock: true })
    const r = await orderPayout(ordenValida())
    expect(r.mock).toBe(true)
  })
})

describe('validación: nada se reclama si la orden está mal', () => {
  // Esta es la razón de ser del orden. Si alguna de estas llamara al claim,
  // el error más frecuente dejaría operaciones reclamadas sin orden en el banco.
  const casos = [
    ['sin reference',            { reference: undefined }],
    ['targetModel inválido',     { targetModel: 'Pepito' }],
    ['purpose inválido',         { purpose: 'otra_cosa' }],
    ['monto cero',               { amount: 0 }],
    ['monto negativo',           { amount: -5 }],
    ['sin cuenta destino',       { beneficiary: { bankCode: '1018', name: 'Juana' } }],
    ['sin banco destino',        { beneficiary: { accountCode: '123', name: 'Juana' } }],
    ['sin origen de fondos',     { amlData: { destination: 'x' } }],
    ['sin destino de fondos',    { amlData: { source: 'x' } }],
  ]

  it.each(casos)('%s: rechaza sin reclamar ni ordenar', async (_, roto) => {
    const claim = jest.fn(async () => true)
    const r = await orderPayout(ordenValida({ ...roto, claim }))

    expect(r.ok).toBe(false)
    expect(r.code).toBe(PAYOUT_ERRORS.INVALID_REQUEST)
    expect(claim).not.toHaveBeenCalled()
    expect(transferSpy).not.toHaveBeenCalled()
  })

  it('la declaración de origen y destino de fondos no admite default', async () => {
    const r = await orderPayout(ordenValida({ amlData: undefined }))
    expect(r.reason).toMatch(/no admiten un valor por omisión/)
  })
})

describe('proveedor y liquidez', () => {
  it('sin adapter: no reclama', async () => {
    adapterPresente = false
    const claim = jest.fn(async () => true)
    const r = await orderPayout(ordenValida({ claim }))

    expect(r.code).toBe(PAYOUT_ERRORS.NO_PROVIDER)
    expect(httpStatusFor(r.code)).toBe(501)
    expect(claim).not.toHaveBeenCalled()
  })

  it('liquidez insuficiente: no reclama ni ordena', async () => {
    process.env.WALLET_BANK_LIQUIDITY_CHECK = 'true'
    balanceSpy.mockResolvedValue({ available: 50, ok: true })
    const claim = jest.fn(async () => true)

    const r = await orderPayout(ordenValida({ amount: 100, claim }))

    expect(r.code).toBe(PAYOUT_ERRORS.INSUFFICIENT_LIQUIDITY)
    expect(httpStatusFor(r.code)).toBe(409)
    expect(claim).not.toHaveBeenCalled()
    expect(transferSpy).not.toHaveBeenCalled()
  })

  it('el pre-check apagado no consulta saldo', async () => {
    await orderPayout(ordenValida())
    expect(balanceSpy).not.toHaveBeenCalled()
  })

  it('si la consulta de saldo no responde, deja pasar (fail-open)', async () => {
    process.env.WALLET_BANK_LIQUIDITY_CHECK = 'true'
    balanceSpy.mockResolvedValue({ available: null, ok: false })

    const r = await orderPayout(ordenValida())
    expect(r.ok).toBe(true)
  })

  it('liquidityCheck explícito gana sobre el entorno', async () => {
    balanceSpy.mockResolvedValue({ available: 1, ok: true })
    const r = await orderPayout(ordenValida({ amount: 100, liquidityCheck: true }))
    expect(r.code).toBe(PAYOUT_ERRORS.INSUFFICIENT_LIQUIDITY)
  })

  it('cuando se verifica de verdad, el resultado lo dice', async () => {
    const r = await orderPayout(ordenValida({ liquidityCheck: true }))
    expect(r).toMatchObject({ ok: true, liquidityChecked: true })
  })

  // Este es el caso que antes pasaba en silencio y es el de Red Enlace hoy: el
  // gate encendido contra un proveedor que no sabe responder el saldo. No debe
  // bloquear, pero tampoco puede hacerse pasar por verificado.
  it('proveedor que NO sabe responder el saldo: sale igual pero marcado como no verificado', async () => {
    adapterSinSaldo = true
    const r = await orderPayout(ordenValida({ liquidityCheck: true }))

    expect(r.ok).toBe(true)
    expect(r.liquidityChecked).toBe(false)
    expect(balanceSpy).not.toHaveBeenCalled()
  })

  it('con el gate apagado tampoco se declara verificado', async () => {
    const r = await orderPayout(ordenValida())
    expect(r).toMatchObject({ ok: true, liquidityChecked: false })
  })

  it('si la consulta responde ok:false, no se declara verificado', async () => {
    balanceSpy.mockResolvedValue({ available: null, ok: false })
    const r = await orderPayout(ordenValida({ liquidityCheck: true }))
    expect(r).toMatchObject({ ok: true, liquidityChecked: false })
  })
})

describe('carrera: dos procesos sobre la misma operación', () => {
  it('el que pierde el claim no ordena nada y no revierte', async () => {
    const revert = jest.fn()
    const r = await orderPayout(ordenValida({ claim: async () => false, revert }))

    expect(r.code).toBe(PAYOUT_ERRORS.ALREADY_CLAIMED)
    expect(httpStatusFor(r.code)).toBe(409)
    expect(transferSpy).not.toHaveBeenCalled()
    // Revertir acá pisaría el estado del proceso que SÍ se quedó con la operación.
    expect(revert).not.toHaveBeenCalled()
    expect(r.retryable).toBe(false)
  })
})

describe('el banco rechaza la orden', () => {
  it('revierte el claim y habilita reintento', async () => {
    transferSpy.mockRejectedValue(new Error('ciNitDestino es requerido'))
    const revert = jest.fn(async () => {})

    const r = await orderPayout(ordenValida({ claim: async () => true, revert }))

    expect(r.code).toBe(PAYOUT_ERRORS.PROVIDER_ERROR)
    expect(httpStatusFor(r.code)).toBe(502)
    expect(revert).toHaveBeenCalledTimes(1)
    expect(r.retryable).toBe(true)
    expect(r.reason).toMatch(/ciNitDestino/)
  })

  it('si la reversión también falla, la operación queda trabada y NO reintentable', async () => {
    // El peor caso: reclamada, sin orden en el banco y sin vuelta atrás.
    // Declararla reintentable invitaría a un segundo débito.
    transferSpy.mockRejectedValue(new Error('timeout del banco'))
    const revert = jest.fn(async () => { throw new Error('mongo no responde') })

    const r = await orderPayout(ordenValida({ claim: async () => true, revert }))

    expect(r.ok).toBe(false)
    expect(r.retryable).toBe(false)
    expect(r.reason).toMatch(/trabada/)
    expect(r.reason).toMatch(/timeout del banco/)
    expect(r.reason).toMatch(/mongo no responde/)
  })

  it('sin callback de revert no estalla', async () => {
    transferSpy.mockRejectedValue(new Error('x'))
    const r = await orderPayout(ordenValida({ claim: async () => true }))
    expect(r.code).toBe(PAYOUT_ERRORS.PROVIDER_ERROR)
  })
})

describe('httpStatusFor', () => {
  it('traduce cada código y cae en 500 ante uno desconocido', () => {
    expect(httpStatusFor(PAYOUT_ERRORS.INVALID_REQUEST)).toBe(400)
    expect(httpStatusFor(PAYOUT_ERRORS.NO_PROVIDER)).toBe(501)
    expect(httpStatusFor('inventado')).toBe(500)
  })
})
