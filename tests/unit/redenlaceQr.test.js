/**
 * redenlaceQr.test.js — Contrato del cobro por QR Simple de ATC (Red Enlace).
 *
 * Lo que se protege acá no es "que llame al endpoint correcto". Es un puñado de
 * decisiones que, si se rompen, fallan en silencio y con dinero de por medio:
 *
 *   - el `qrId` que guardamos es el `numeroReferencia` de ATC, porque es el
 *     único valor que aparece también en el webhook. Guardar el nuestro dejaría
 *     los pagos sin forma de atribuirse.
 *   - un webhook plano se traduce a la forma anidada que espera el handler.
 *   - la autenticación del webhook falla cerrada.
 *   - la imagen se declara PNG. Declararla SVG no rompe nada del lado del
 *     servidor: rompe la pantalla del usuario.
 */

import { jest } from '@jest/globals'
import '../setup.env.js'

const ENV_KEYS = [
  'REDENLACE_BASE_URL', 'REDENLACE_CLIENT_ID', 'REDENLACE_CLIENT_SECRET',
  'REDENLACE_MOCK_ENABLED', 'REDENLACE_ESTABLISHMENT_ID', 'REDENLACE_ESTABLISHMENT_NAME',
  'REDENLACE_QR_WEBHOOK_URL', 'REDENLACE_QR_WEBHOOK_KEY', 'REDENLACE_QR_WEBHOOK_VALUE',
  'REDENLACE_QR_VIGENCIA_SECONDS', 'NODE_ENV',
]
const SNAPSHOT = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

let svc, client

beforeAll(async () => {
  svc    = await import('../../src/services/bankQr/banks/redenlaceQrService.js')
  client = await import('../../src/services/bank/redenlaceClient.js')
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SNAPSHOT[k] === undefined) delete process.env[k]
    else process.env[k] = SNAPSHOT[k]
  }
  client.resetTokenCache()
  jest.restoreAllMocks()
})

/** Deja el servicio en modo real con todo lo mínimo configurado. */
function configureReal() {
  process.env.REDENLACE_BASE_URL            = 'https://atcgwapitest.redenlace.com.bo/sandbox'
  process.env.REDENLACE_CLIENT_ID           = 'client-id-de-prueba'
  process.env.REDENLACE_CLIENT_SECRET       = 'client-secret-de-prueba'
  process.env.REDENLACE_ESTABLISHMENT_ID    = '422717'
  process.env.REDENLACE_QR_WEBHOOK_URL      = 'https://api.alyto.app/api/v1/ipn/redenlace'
  process.env.REDENLACE_QR_WEBHOOK_KEY      = 'x-api-key'
  process.env.REDENLACE_QR_WEBHOOK_VALUE    = 'secreto-de-prueba'
  delete process.env.REDENLACE_MOCK_ENABLED
}

/** fetch falso: primero responde el token, después lo que se le indique. */
function mockFetchSequence(...responses) {
  const calls = []
  const queue = [
    { access_token: 'token-de-prueba', token_type: 'Bearer', expires_in: 3600 },
    ...responses,
  ]
  jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
    calls.push({ url: String(url), options })
    const body = queue.shift()
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  })
  return calls
}

describe('redenlaceQrService — generación', () => {
  test('el qrId guardado es el numeroReferencia de ATC, no el nuestro', async () => {
    configureReal()
    mockFetchSequence({
      success: true,
      message: 'QR generado exitosamente',
      data: {
        numeroReferencia:           '153980',   // el de ATC
        numeroReferenciaOriginante: 'ALY-C-123', // el nuestro
        estado:                     'PENDIENTE',
        fechaExpiracion:            '2026-03-12T18:01:52.304',
        moneda:                     'BOB',
        monto:                      10.5,
        qr:                         'iVBORw0KGgo=',
      },
    })

    const out = await svc.generateQR({ transactionId: 'ALY-C-123', amount: 10.5, description: 'test' })

    // Si esto se invierte, el webhook llega con '153980' y no matchea nada.
    expect(out.qrId).toBe('153980')
    expect(out.qrId).not.toBe('ALY-C-123')
  })

  test('declara la imagen como PNG (ATC no devuelve SVG como BANECO)', async () => {
    configureReal()
    mockFetchSequence({
      success: true,
      data: { numeroReferencia: '1', qr: 'iVBORw0KGgo=', fechaExpiracion: '2026-03-12T18:01:52.304' },
    })
    const out = await svc.generateQR({ transactionId: 'T', amount: 1 })
    expect(out.qrImageMime).toBe('image/png')
  })

  test('devuelve la expiración que informa ATC, que manda sobre BANK_QR_DUE_DAYS', async () => {
    configureReal()
    mockFetchSequence({
      success: true,
      data: { numeroReferencia: '1', qr: 'x', fechaExpiracion: '2026-03-12T18:01:52.304' },
    })
    const out = await svc.generateQR({ transactionId: 'T', amount: 1 })
    expect(out.expiresAt).toBeInstanceOf(Date)
    expect(out.expiresAt.toISOString()).toContain('2026-03-12')
  })

  test('manda la vigencia configurada y el establecimiento como número', async () => {
    configureReal()
    process.env.REDENLACE_QR_VIGENCIA_SECONDS = '900'
    const calls = mockFetchSequence({ success: true, data: { numeroReferencia: '1', qr: 'x' } })

    await svc.generateQR({ transactionId: 'T', amount: 1 })

    const generate = calls.find((c) => c.url.includes('/qr/simple/v2/generate'))
    const body     = JSON.parse(generate.options.body)
    expect(body.vigencia).toBe(900)
    expect(body.idEstablecimiento).toBe(422717)   // number, no string
    expect(body.moneda).toBe('BOB')
    expect(body.webhook.key).toBe('x-api-key')
  })

  test('rechaza monedas distintas de BOB en vez de dejar que ATC decida', async () => {
    configureReal()
    await expect(svc.generateQR({ transactionId: 'T', amount: 1, currency: 'USD' }))
      .rejects.toThrow(/solo opera en BOB/i)
  })

  test('sin webhook configurado no genera: un cobro sin confirmación es un cobro perdido', async () => {
    configureReal()
    delete process.env.REDENLACE_QR_WEBHOOK_VALUE
    await expect(svc.generateQR({ transactionId: 'T', amount: 1 }))
      .rejects.toThrow(/WEBHOOK/i)
  })

  test('sin credenciales cae a mock y no intenta salir a la red', async () => {
    delete process.env.REDENLACE_CLIENT_ID
    delete process.env.REDENLACE_CLIENT_SECRET
    const spy = jest.spyOn(global, 'fetch')

    const out = await svc.generateQR({ transactionId: 'ALY-C-999', amount: 5 })

    expect(out._mock).toBe(true)
    expect(out.qrId).toMatch(/^mock-rl-/)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('redenlaceQrService — estado', () => {
  const cases = [
    ['PENDIENTE', 'pending'],
    ['PAGADO',    'paid'],
    ['CANCELADO', 'cancelled'],
    ['EXPIRADO',  'cancelled'],   // para el barrido son el mismo caso
    ['ERROR',     'unknown'],
    ['LO_QUE_SEA','unknown'],     // nunca inventar un estado
  ]

  test.each(cases)('traduce %s → %s', async (estado, esperado) => {
    configureReal()
    mockFetchSequence({ success: true, data: { estado, importe: 10.5, moneda: 'BOB' } })
    const { status } = await svc.getQRStatus('153980')
    expect(status).toBe(esperado)
  })

  test('solo adjunta el pago cuando está pagado', async () => {
    configureReal()
    mockFetchSequence({ success: true, data: { estado: 'PENDIENTE', importe: 10.5 } })
    const r = await svc.getQRStatus('153980')
    expect(r.payment).toBeNull()
  })
})

describe('redenlaceQrService — webhook', () => {
  const BODY = {
    detalleRespuesta:     'Transacción procesada correctamente',
    codigoRespuesta:      'SUCCESS',
    numeroReferencia:     '233324',
    monto:                10.5,
    moneda:               'BOB',
    fechaHoraTransaccion: '2026-05-26T14:35:20',
    clienteOrigen: { ciCliente: '12345678', nombreCliente: 'Juan Perez', numeroCuenta: '1234567890' },
    bancoOrigen:   { codigoBanco: '101', nombreBanco: 'Banco Unión', numeroOrdenAch: '987654321' },
  }

  test('traduce el payload plano de ATC a la forma que espera el handler', () => {
    const p = svc.normalizeIpn({ body: BODY })

    expect(p.qrId).toBe('233324')
    expect(p.amount).toBe(10.5)
    expect(p.senderName).toBe('Juan Perez')
    // confirmBankQrTx reconstruye la fecha de pago desde estos dos campos.
    expect(p.paymentDate).toBe('2026-05-26')
    expect(p.paymentTime).toBe('14:35:20')
  })

  test('un body sin numeroReferencia no produce un pago fantasma', () => {
    expect(svc.normalizeIpn({ body: { monto: 10 } })).toBeNull()
  })

  test('rechaza si la cabecera de autenticación no coincide', async () => {
    configureReal()
    const r = await svc.verifyIpn({ body: BODY, headers: { 'x-api-key': 'valor-equivocado' } })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('bad-webhook-key')
  })

  test('rechaza si la cabecera falta directamente', async () => {
    configureReal()
    const r = await svc.verifyIpn({ body: BODY, headers: {} })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('bad-webhook-key')
  })

  test('con cabecera válida, sigue exigiendo que ATC confirme el pago', async () => {
    configureReal()
    mockFetchSequence({ success: true, data: { estado: 'PENDIENTE', importe: 10.5 } })

    const r = await svc.verifyIpn({ body: BODY, headers: { 'x-api-key': 'secreto-de-prueba' } })

    // La cabecera es correcta pero ATC dice pendiente: no se acredita.
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('bank-status-pending')
  })

  test('acepta solo cuando la cabecera es válida Y ATC dice PAGADO', async () => {
    configureReal()
    mockFetchSequence({
      success: true,
      data: { estado: 'PAGADO', importe: 10.5, moneda: 'BOB', clienteOrigen: BODY.clienteOrigen, bancoOrigen: BODY.bancoOrigen },
    })

    const r = await svc.verifyIpn({ body: BODY, headers: { 'x-api-key': 'secreto-de-prueba' } })

    expect(r.ok).toBe(true)
    expect(r.payment.amount).toBe(10.5)
  })

  test('en producción, el modo mock nunca acredita', async () => {
    delete process.env.REDENLACE_CLIENT_ID
    delete process.env.REDENLACE_CLIENT_SECRET
    process.env.NODE_ENV = 'production'

    const r = await svc.verifyIpn({ body: BODY, headers: {} })

    expect(r.ok).toBe(false)
    expect(r.reason).toBe('mock-mode-forbidden-in-prod')
  })
})

describe('redenlaceClient — autenticación', () => {
  test('manda el token crudo en access_token, no como Bearer', async () => {
    configureReal()
    const calls = mockFetchSequence({ success: true, data: { estado: 'PENDIENTE' } })

    await svc.getQRStatus('1')

    const verify = calls.find((c) => c.url.includes('/qr/simple/v2/verify'))
    expect(verify.options.headers.access_token).toBe('token-de-prueba')
    expect(verify.options.headers.client_id).toBe('client-id-de-prueba')
    expect(verify.options.headers.Authorization).toBeUndefined()
  })

  test('reusa el token entre llamadas en vez de autenticar cada vez', async () => {
    configureReal()
    const calls = mockFetchSequence(
      { success: true, data: { estado: 'PENDIENTE' } },
      { success: true, data: { estado: 'PENDIENTE' } },
    )

    await svc.getQRStatus('1')
    await svc.getQRStatus('2')

    const auths = calls.filter((c) => c.url.includes('/oauth-client-credentials/'))
    expect(auths).toHaveLength(1)
  })

  test('no manda el client_secret por http plano aunque lo diga la documentación', async () => {
    configureReal()
    process.env.REDENLACE_BASE_URL = 'http://api.redenlace.com.bo'
    jest.spyOn(global, 'fetch')

    await expect(svc.getQRStatus('1')).rejects.toThrow(/https/i)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('tolera la barra final con la que el portal publica la URL base', async () => {
    configureReal()
    process.env.REDENLACE_BASE_URL = 'https://atcgwapitest.redenlace.com.bo/sandbox/'
    const calls = mockFetchSequence({ success: true, data: { estado: 'PENDIENTE' } })

    await svc.getQRStatus('1')

    expect(calls.every((c) => !c.url.includes('//oauth') && !c.url.includes('sandbox//'))).toBe(true)
  })
})

describe('bankQrRegistry — alta de Red Enlace', () => {
  test('queda registrado y expone el contrato completo', async () => {
    const { getBankQrService, listBankIds } = await import('../../src/services/bankQr/bankQrRegistry.js')

    expect(listBankIds()).toContain('redenlace')

    const s = getBankQrService('redenlace')
    for (const fn of ['generateQR', 'cancelQR', 'getQRStatus', 'getPaidQRs', 'isAvailable', 'verifyIpn', 'normalizeIpn']) {
      expect(typeof s[fn]).toBe('function')
    }
  })

  test('cancelQR no lanza: ATC no la ofrece y el barrido la llama en cada vencimiento', async () => {
    await expect(svc.cancelQR('153980')).resolves.toBeUndefined()
  })

  test('getPaidQRs devuelve vacío sin romper la FASE A del job', async () => {
    await expect(svc.getPaidQRs(new Date())).resolves.toEqual([])
  })
})
