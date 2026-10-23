/**
 * redenlaceDisbursement.test.js — Dispersión de fondos de ATC (Pay Out Asíncrono).
 *
 * Es dinero saliendo, así que lo que se protege no son los campos del JSON sino
 * las formas en que una orden puede salir mal sin que nadie se entere:
 *
 *   - que un lote "exitoso" con un ítem rechazado se dé por despachado
 *   - que una orden real se dispare sin haber confirmado el ambiente
 *   - que el webhook acredite sin autenticación
 *   - que una devolución (REVERTIDO) se registre como pago exitoso
 *   - que la fecha se calcule en la zona del servidor y el retiro se programe
 *     para el día siguiente
 *
 * Es de integración porque el alias numérico vive en Mongo: sin base, la mitad
 * de estas pruebas no ejercitaría el camino real.
 */

import '../setup.env.js'
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js'

const ENV_KEYS = [
  'REDENLACE_BASE_URL', 'REDENLACE_CLIENT_ID', 'REDENLACE_CLIENT_SECRET',
  'REDENLACE_MOCK_ENABLED', 'REDENLACE_BRANCH_CODE', 'REDENLACE_ESTABLISHMENT_ID',
  'REDENLACE_ACCOUNT', 'REDENLACE_PAYOUT_SUCURSAL',
  'REDENLACE_PAYOUT_WEBHOOK_URL', 'REDENLACE_PAYOUT_WEBHOOK_TOKEN',
  'WALLET_REDENLACE_DISBURSEMENT_ENABLED', 'REDENLACE_DISBURSEMENT_PRODUCTION_CONFIRMED',
  'NODE_ENV',
]
const SNAPSHOT = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

let svc, client, refSvc

beforeAll(async () => {
  await connectTestDb()
  svc    = await import('../../src/services/bank/redenlaceDisbursementService.js')
  client = await import('../../src/services/bank/redenlaceClient.js')
  refSvc = await import('../../src/services/bank/providerReference.js')
  const PR = (await import('../../src/models/ProviderReference.js')).default
  await PR.syncIndexes()
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (SNAPSHOT[k] === undefined) delete process.env[k]
    else process.env[k] = SNAPSHOT[k]
  }
  client.resetTokenCache()
  globalThis.fetch = undefined
  await clearCollections()
})

afterAll(async () => { await disconnectTestDb() })

/** Deja el servicio habilitado para dispersar de verdad contra certificación. */
function configurarReal() {
  process.env.REDENLACE_BASE_URL                       = 'https://atcgwapitest.redenlace.com.bo/sandbox'
  process.env.REDENLACE_CLIENT_ID                      = 'id-de-prueba'
  process.env.REDENLACE_CLIENT_SECRET                  = 'secret-de-prueba'
  process.env.REDENLACE_BRANCH_CODE                    = '420056'
  process.env.REDENLACE_ACCOUNT                        = '7014200561'
  process.env.REDENLACE_PAYOUT_SUCURSAL                = 'LPZ'
  process.env.REDENLACE_PAYOUT_WEBHOOK_URL             = 'https://api-staging.alyto.app/api/v1/ipn/redenlace-disbursement?token=secreto'
  process.env.REDENLACE_PAYOUT_WEBHOOK_TOKEN           = 'secreto'
  process.env.WALLET_REDENLACE_DISBURSEMENT_ENABLED    = 'true'
  delete process.env.REDENLACE_MOCK_ENABLED
}

/** Orden válida mínima. */
const ORDEN = (over = {}) => ({
  batchId:       'WTX-1',
  batchDetailId: 'WTX-1',
  amount:        100,
  currency:      'BOB',
  description:   'Retiro Alyto',
  beneficiary: {
    accountCode: '1311404044',
    bankCode:    '1018',
    name:        'JOSE PEREZ',
    docId:       '5452452',
  },
  ...over,
})

/** fetch falso ruteado por URL: el cliente cachea el token entre pruebas. */
function stubFetch(loteResponse) {
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    const body = String(url).includes('/oauth-client-credentials/')
      ? { access_token: 'tok', expires_in: 3600 }
      : loteResponse
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }
  return calls
}

const LOTE_OK = {
  code: '00', message: 'success',
  data: {
    nroLote: '2601191040', processId: 'uuid',
    transacciones: [{ transaccionId: '100000001', estado: 'PENDIENTE', numeroReferencia: '502125545442601', mensaje: 'En proceso.' }],
  },
}

describe('validación previa — lo que ATC rechazaría', () => {
  beforeEach(configurarReal)

  test('exige el documento del beneficiario, que BANECO aceptaba vacío', async () => {
    const orden = ORDEN()
    delete orden.beneficiary.docId

    await expect(svc.transfer(orden)).rejects.toThrow(/documento del beneficiario/i)
  })

  test('rechaza un documento más corto que el mínimo de ATC', async () => {
    await expect(svc.transfer(ORDEN({ beneficiary: { ...ORDEN().beneficiary, docId: '123' } })))
      .rejects.toThrow(/5 a 20/)
  })

  test('rechaza un titular que no entra en el campo', async () => {
    await expect(svc.transfer(ORDEN({ beneficiary: { ...ORDEN().beneficiary, name: 'AB' } })))
      .rejects.toThrow(/titularDestino/)
  })

  test('rechaza una sucursal fuera del catálogo de ATC', async () => {
    process.env.REDENLACE_PAYOUT_SUCURSAL = 'XYZ'
    await expect(svc.transfer(ORDEN())).rejects.toThrow(/sucursal inválida/i)
  })

  test('valida antes de llamar al banco, no después', async () => {
    const calls = stubFetch(LOTE_OK)
    const orden = ORDEN()
    delete orden.beneficiary.docId

    await expect(svc.transfer(orden)).rejects.toThrow()

    // Si llamara y después validara, el retiro quedaría despachado sin orden.
    expect(calls.filter((c) => c.url.includes('/lote/autorizar'))).toHaveLength(0)
  })
})

describe('autorización del lote', () => {
  beforeEach(configurarReal)

  test('arma la transacción con los campos que exige ATC', async () => {
    const calls = stubFetch(LOTE_OK)

    await svc.transfer(ORDEN())

    const req = calls.find((c) => c.url.includes('/lote/autorizar'))
    const body = JSON.parse(req.options.body)
    const t = body.transacciones[0]

    expect(req.options.headers.branchCode).toBe('420056')
    expect(body.processId).toMatch(/^[0-9a-f-]{36}$/)
    expect(t.cuentaOrigen).toBe('7014200561')
    expect(t.cuentaDestino).toBe('1311404044')
    expect(t.codeBanco).toBe('1018')
    expect(t.codeSucursal).toBe('LPZ')
    expect(t.ciNitDestino).toBe('5452452')
    expect(t.tipoMoneda).toBe('BOB')
  })

  test('el transaccionId es el alias corto, no nuestro wtxId', async () => {
    const calls = stubFetch(LOTE_OK)

    await svc.transfer(ORDEN())

    const t = JSON.parse(calls.find((c) => c.url.includes('/lote/autorizar')).options.body).transacciones[0]
    expect(t.transaccionId).toMatch(/^\d{9}$/)
    expect(t.transaccionId).not.toBe('WTX-1')
    expect(t.transaccionId.length).toBeLessThanOrEqual(14)
  })

  // ATC exige fechaTransaccion >= hoy. El VPS corre en UTC, que entre las 20:00
  // y medianoche de Bolivia ya está en el día siguiente: mandar la fecha UTC
  // pasaría la validación pero programaría el retiro para mañana.
  test('la fecha se calcula en Bolivia, no en la zona del servidor', async () => {
    const calls = stubFetch(LOTE_OK)

    await svc.transfer(ORDEN())

    const t = JSON.parse(calls.find((c) => c.url.includes('/lote/autorizar')).options.body).transacciones[0]
    const esperada = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10)
    expect(t.fechaTransaccion).toBe(esperada)
  })

  test('devuelve el número de lote y guarda la referencia de ATC para la vuelta', async () => {
    stubFetch(LOTE_OK)

    const out = await svc.transfer(ORDEN())

    expect(out.bankBatchId).toBe('2601191040')

    // Sin esto, una conciliación de ATC no tendría cómo llegar al retiro.
    const doc = await refSvc.resolveByExternal('redenlace', '502125545442601')
    expect(doc.targetId).toBe('WTX-1')
    expect(doc.kind).toBe('payout')
  })

  // ⚠️ El riesgo más silencioso de esta API.
  test('un lote "exitoso" con el ítem en ERROR no se da por despachado', async () => {
    stubFetch({
      code: '00', message: 'Operación exitosa',
      data: {
        nroLote: '2601191040',
        transacciones: [{ transaccionId: '100000001', estado: 'ERROR', mensaje: 'Codigo de banco no habilitado' }],
      },
    })

    await expect(svc.transfer(ORDEN())).rejects.toThrow(/Codigo de banco no habilitado/)
  })

  test('un error de validación del lote se propaga con su código', async () => {
    stubFetch({ data: null, code: '02', message: 'processId: formato UUID' })
    await expect(svc.transfer(ORDEN())).rejects.toThrow(/\[02\]/)
  })

  test('dos dispatch del mismo retiro mandan el MISMO transaccionId', async () => {
    const calls = stubFetch(LOTE_OK)

    await svc.transfer(ORDEN())
    await svc.transfer(ORDEN())

    const ids = calls.filter((c) => c.url.includes('/lote/autorizar'))
      .map((c) => JSON.parse(c.options.body).transacciones[0].transaccionId)

    // Dos identificadores para una sola orden le pediría al banco pagar dos veces.
    expect(new Set(ids).size).toBe(1)
  })
})

describe('gates del dinero saliente', () => {
  test('sin el gate explícito simula, aunque haya credenciales', async () => {
    configurarReal()
    process.env.WALLET_REDENLACE_DISBURSEMENT_ENABLED = 'false'
    const calls = stubFetch(LOTE_OK)

    const out = await svc.transfer(ORDEN())

    expect(out._mock).toBe(true)
    expect(calls.filter((c) => c.url.includes('/lote/autorizar'))).toHaveLength(0)
  })

  // El portal de ATC emite credenciales de certificación bajo un gateway
  // rotulado "ATC Prod": ni la etiqueta ni las credenciales distinguen el
  // ambiente. La URL sí, y por eso es la que gobierna la tercera llave.
  test('contra producción exige una confirmación de ambiente aparte', async () => {
    configurarReal()
    process.env.REDENLACE_BASE_URL = 'https://api.redenlace.com.bo'
    const calls = stubFetch(LOTE_OK)

    await expect(svc.transfer(ORDEN())).rejects.toThrow(/PRODUCTION_CONFIRMED/)
    expect(calls.filter((c) => c.url.includes('/lote/autorizar'))).toHaveLength(0)
  })

  test('con la confirmación de ambiente, contra producción sí procede', async () => {
    configurarReal()
    process.env.REDENLACE_BASE_URL = 'https://api.redenlace.com.bo'
    process.env.REDENLACE_DISBURSEMENT_PRODUCTION_CONFIRMED = 'true'
    const calls = stubFetch(LOTE_OK)

    await svc.transfer(ORDEN())

    expect(calls.filter((c) => c.url.includes('/lote/autorizar'))).toHaveLength(1)
  })

  test('sin webhook no dispersa: un retiro sin confirmación queda colgado', async () => {
    configurarReal()
    delete process.env.REDENLACE_PAYOUT_WEBHOOK_URL
    stubFetch(LOTE_OK)

    await expect(svc.transfer(ORDEN())).rejects.toThrow(/WEBHOOK/i)
  })
})

describe('webhook de confirmación', () => {
  beforeEach(configurarReal)

  test('el token viaja en el query string y se compara completo', () => {
    expect(svc.verifyNotifyStatus({ query: { token: 'secreto' } }).ok).toBe(true)
    expect(svc.verifyNotifyStatus({ query: { token: 'otro' } }).reason).toBe('bad-token')
    expect(svc.verifyNotifyStatus({ query: {} }).reason).toBe('bad-token')
    expect(svc.verifyNotifyStatus({ query: { token: 'secret' } }).reason).toBe('bad-token')
  })

  test('en producción sin token configurado, falla cerrado', () => {
    delete process.env.REDENLACE_PAYOUT_WEBHOOK_TOKEN
    process.env.NODE_ENV = 'production'

    const r = svc.verifyNotifyStatus({ query: { token: 'lo-que-sea' } })

    // No hay reconfirmación contra ATC antes de liquidar, así que aceptar por
    // estructura dejaría que cualquiera marcara retiros como acreditados.
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no-token-prod-fail-closed')
  })

  test('traduce el alias de vuelta al retiro', async () => {
    stubFetch(LOTE_OK)
    await svc.transfer(ORDEN())
    const alias = (await refSvc.resolveByExternal('redenlace', '502125545442601')).reference

    const norm = await svc.normalizeNotify({ body: {
      nroLote: '2601191045', transaccionId: alias, numeroReferencia: '51021455454645646',
      estado: 'PAGADO', mensaje: 'Transacción acreditada en cuenta destino',
      numeroAch: '14000260518000001', importe: 100,
    } })

    expect(norm.wtxId).toBe('WTX-1')
    expect(norm.status).toBe('PAGADO')
    expect(norm.bankReference).toBe('14000260518000001')
  })

  test('un alias desconocido no resuelve a un retiro cualquiera', async () => {
    expect(await svc.normalizeNotify({ body: { transaccionId: '999999999', estado: 'PAGADO' } })).toBeNull()
    expect(await svc.normalizeNotify({ body: { estado: 'PAGADO' } })).toBeNull()
  })
})

describe('traducción de estados', () => {
  test.each([
    ['PAGADO',     'accepted'],
    ['COMPLETADO', 'accepted'],
    ['RECHAZADO',  'rejected'],
    ['CANCELADO',  'rejected'],
  ])('%s → %s', (estado, esperado) => {
    expect(svc.mapNotifyStatus(estado)).toBe(esperado)
  })

  test.each(['PENDIENTE', 'PROCESO', 'ENVIADO', 'PENDIENTE_CONFIRMACION'])(
    '%s no dispara ninguna acción todavía', (estado) => {
      expect(svc.mapNotifyStatus(estado)).toBe('unknown')
    })

  // REVERTIDO = un retiro YA PAGADO volvió. No tenemos camino de reversa: el
  // saldo del usuario ya se debitó y habría que reacreditarlo. Mapearlo a
  // 'rejected' intentaría liberar una reserva inexistente y dejaría el registro
  // diciendo que el retiro falló, cuando en realidad se pagó y se devolvió.
  test('REVERTIDO no se hace pasar por un rechazo', () => {
    expect(svc.mapNotifyStatus('REVERTIDO')).toBe('unknown')
    expect(svc.mapNotifyStatus('REVERTIDO')).not.toBe('rejected')
    expect(svc.mapNotifyStatus('REVERTIDO')).not.toBe('accepted')
  })

  test('un estado desconocido no se inventa', () => {
    expect(svc.mapNotifyStatus('LO_QUE_SEA')).toBe('unknown')
    expect(svc.mapNotifyStatus(undefined)).toBe('unknown')
  })
})
