/**
 * redenlaceAccount.test.js — Cuentas de Comercio de ATC.
 *
 * Lo que importa de este servicio no es que traiga un número: es CUÁL número.
 * `saldoDisponible` viene neto de retenciones desde ATC, y derivarlo a mano
 * (`contable − retenido`) sería inventar una definición que puede dejar de
 * coincidir sin que nadie se entere.
 *
 * Las dos rarezas del API se fijan acá porque son lo primero que se va a
 * olvidar: el campo de la lista de cuentas se llama `numeroCuentas` en /saldos
 * y `numeroCuenta` en /creditos, y los límites (10 cuentas, 31 días) son
 * distintos por endpoint.
 */

import { jest } from '@jest/globals'
import '../setup.env.js'

const apiFetchSpy = jest.fn()
let mockMode = false

await jest.unstable_mockModule('../../src/services/bank/redenlaceClient.js', () => ({
  apiFetch:    (...a) => apiFetchSpy(...a),
  isAvailable: () => true,
  isMockMode:  () => mockMode,
  getToken:    jest.fn(async () => 'tok'),
}))

const svc = await import('../../src/services/bank/redenlaceAccountService.js')

const SALDO_OK = {
  code: '00',
  errorCode: '',
  errorMessage: '',
  data: [{
    estado: 'ACTIVA',
    numeroCuenta: '7014227171',
    tipoMoneda: 'BOB',
    saldoDisponible: 59.50,
    saldoContable: 84.50,
    saldoRetenido: 25.00,
    fechaUltimoCredito: '2026-05-12T10:55:46',
    fechaUltimoDebito: null,
  }],
}

beforeEach(() => {
  mockMode = false
  apiFetchSpy.mockReset()
  process.env.REDENLACE_NIT     = '6731850'
  process.env.REDENLACE_ACCOUNT = '7014227171'
})

describe('getBalance', () => {
  it('usa saldoDisponible tal cual, no lo deriva de contable menos retenido', async () => {
    // Si alguien "optimizara" calculándolo, acá daría 59.50 por casualidad.
    // El caso sembrado tiene 84.50 − 25.00 = 59.50, así que el valor coincide,
    // pero lo que se exige es que venga del campo correcto: `withheld` y
    // `balance` tienen que llegar por separado y sin tocar.
    apiFetchSpy.mockResolvedValue(SALDO_OK)

    const r = await svc.getBalance()

    expect(r.available).toBe(59.50)
    expect(r.balance).toBe(84.50)
    expect(r.withheld).toBe(25.00)
    expect(r.currency).toBe('BOB')
    expect(r.status).toBe('ACTIVA')
  })

  it('pide la cuenta configurada en el campo PLURAL numeroCuentas', async () => {
    apiFetchSpy.mockResolvedValue(SALDO_OK)
    await svc.getBalance()

    const [ruta, opts] = apiFetchSpy.mock.calls[0]
    expect(ruta).toBe('/cuentas-comercios/v1/cuentas/saldos')
    const body = JSON.parse(opts.body)
    expect(body).toEqual({ nit: '6731850', numeroCuentas: ['7014227171'] })
  })

  it('una cuenta no activa igual devuelve el saldo, con el estado a la vista', async () => {
    apiFetchSpy.mockResolvedValue({
      ...SALDO_OK,
      data: [{ ...SALDO_OK.data[0], estado: 'BLOQUEADA' }],
    })

    const r = await svc.getBalance()
    expect(r.status).toBe('BLOQUEADA')
    expect(r.available).toBe(59.50)
  })

  it('si ATC responde code distinto de 00, lanza con el mensaje del proveedor', async () => {
    apiFetchSpy.mockResolvedValue({ code: '05', errorCode: 'E12', errorMessage: 'NIT no habilitado' })
    await expect(svc.getBalance()).rejects.toThrow(/NIT no habilitado/)
  })

  it('sin cuentas en la respuesta devuelve nulos, no revienta', async () => {
    apiFetchSpy.mockResolvedValue({ code: '00', data: [] })
    const r = await svc.getBalance()
    expect(r).toMatchObject({ available: null, balance: null })
  })

  it('en modo simulado no sale a la red', async () => {
    mockMode = true
    const r = await svc.getBalance()
    expect(r._mock).toBe(true)
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })
})

describe('límites del API', () => {
  it('rechaza más de 10 cuentas antes de llamar, con nuestro mensaje', async () => {
    // El error de ATC no dice cuál es el límite; preferimos decirlo nosotros.
    const once = Array.from({ length: 11 }, (_, i) => `70142271${i}`)
    await expect(svc.getBalances(once)).rejects.toThrow(/hasta 10 cuentas/)
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('acepta exactamente 10', async () => {
    apiFetchSpy.mockResolvedValue({ code: '00', data: [] })
    const diez = Array.from({ length: 10 }, (_, i) => `70142271${i}`)
    await expect(svc.getBalances(diez)).resolves.toEqual([])
  })

  it('rechaza un rango de movimientos mayor a 31 días', async () => {
    await expect(svc.getMovements('2026-05-01', '2026-07-01')).rejects.toThrow(/31 días/)
    expect(apiFetchSpy).not.toHaveBeenCalled()
  })

  it('rechaza un rango invertido', async () => {
    await expect(svc.getMovements('2026-05-10', '2026-05-01')).rejects.toThrow(/posterior/)
  })
})

describe('tryGetAvailableBalance', () => {
  it('ok true con el saldo cuando responde', async () => {
    apiFetchSpy.mockResolvedValue(SALDO_OK)
    await expect(svc.tryGetAvailableBalance()).resolves.toEqual({ available: 59.50, ok: true })
  })

  it('ok false sin lanzar cuando el proveedor falla', async () => {
    // Es lo que permite el fail-open del guard: distingue "no pude preguntar"
    // de "no hay fondos".
    apiFetchSpy.mockRejectedValue(new Error('gateway caído'))
    const r = await svc.tryGetAvailableBalance()
    expect(r).toMatchObject({ available: null, ok: false })
  })
})

describe('getMovements y normalizeMovement', () => {
  const MOVS = {
    code: '00',
    data: {
      movimientos: [
        {
          transactionId: '213424', tipoOperacion: 'PAYOUT ACH', estado: 'COMPLETADO',
          mensaje: 'Autorizacion transferencia saliente',
          fechaHoraTransaccion: '2026-05-07T16:42:08',
          importe: 100, importeComision: 2, importeTotal: 102, moneda: 'BOB',
          cuentaOrigen: '7014227171', cuentaDestino: '1311404044',
          numOrdenAch: '12454654634534',
        },
        {
          transactionId: '', tipoOperacion: 'PAYIN QR', estado: 'COMPLETADO',
          mensaje: 'Abono', fechaHoraTransaccion: '2026-05-07T09:20:41',
          importe: 10, importeComision: 0, importeTotal: 10, moneda: 'BOB',
          cuentaOrigen: 'ATC-RED ENLACE', cuentaDestino: '7014227171',
          numOrdenAch: '199401',
        },
      ],
      saldos: [{ numeroCuenta: '7014227171', estado: 'ACTIVA', saldoDisponible: 56.86 }],
    },
  }

  it('trae movimientos y usa el saldo de nuestra cuenta como cabecera', async () => {
    apiFetchSpy.mockResolvedValue(MOVS)
    const r = await svc.getMovements('2026-05-01', '2026-05-28')

    expect(r.movements).toHaveLength(2)
    expect(r.header.numeroCuenta).toBe('7014227171')
  })

  it('la dirección sale de la cuenta, no de tipoOperacion', async () => {
    // Un método nuevo de ATC ('PAYIN PIX', 'PAYOUT QR') no debe cambiar cómo se
    // lee el sentido del movimiento.
    apiFetchSpy.mockResolvedValue(MOVS)
    const { movements } = await svc.getMovements('2026-05-01', '2026-05-28')

    const salida  = svc.normalizeMovement(movements[0])
    const entrada = svc.normalizeMovement(movements[1])

    expect(salida.direction).toBe('debit')
    expect(salida.signedAmount).toBe(-102)    // usa importeTotal, con comisión
    expect(entrada.direction).toBe('credit')
    expect(entrada.signedAmount).toBe(10)
  })

  it('el importe normalizado es el total debitado, no el solicitado', async () => {
    apiFetchSpy.mockResolvedValue(MOVS)
    const { movements } = await svc.getMovements('2026-05-01', '2026-05-28')
    expect(svc.normalizeMovement(movements[0]).amount).toBe(102)
  })
})

describe('isAvailable', () => {
  it('exige NIT y cuenta, no solo credenciales del cliente', async () => {
    expect(svc.isAvailable()).toBe(true)
    delete process.env.REDENLACE_NIT
    expect(svc.isAvailable()).toBe(false)
  })
})
