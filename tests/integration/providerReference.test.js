/**
 * providerReference.test.js — El alias corto hacia Red Enlace.
 *
 * Esto existe porque `transaccionId` de ATC admite 14 caracteres y un `wtxId`
 * tiene 24. Las pruebas cubren las dos formas en que este componente puede
 * causar un daño real:
 *
 *   - emitir DOS alias para el mismo retiro (el banco vería dos órdenes)
 *   - emitir el MISMO alias para dos retiros (una conciliación ambigua)
 *
 * El resto son detalles de formato que igual conviene fijar, porque el límite
 * de longitud no vuelve a aparecer hasta que ATC rechaza la petición.
 */

import '../setup.env.js'
import mongoose from 'mongoose'
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js'

let svc, ProviderReference

beforeAll(async () => {
  await connectTestDb()
  svc = await import('../../src/services/bank/providerReference.js')
  ProviderReference = (await import('../../src/models/ProviderReference.js')).default
  // Los índices parciales únicos son el mecanismo de defensa: sin crearlos, las
  // pruebas de carrera pasarían por casualidad.
  await ProviderReference.syncIndexes()
})

afterEach(async () => { await clearCollections() })
afterAll(async () => { await disconnectTestDb() })

const payout = (targetId) => ({
  provider: 'redenlace', kind: 'payout',
  targetModel: 'WalletTransaction', targetId,
  amount: 100, currency: 'BOB',
})

describe('formato del alias', () => {
  test('entra en los 14 caracteres de ATC y en los 10 del QR de activos virtuales', async () => {
    const doc = await svc.issueReference(payout('wtx-1'))
    expect(doc.reference).toHaveLength(9)
    expect(doc.reference.length).toBeLessThanOrEqual(10)
  })

  // El sandbox devolvió `For input string: "9475146471"` ante un alias de 10
  // dígitos: es un NumberFormatException de Java. El techo real del campo no
  // son 10 caracteres, son 2.147.483.647.
  test('entra en un int de 32 bits, que es el techo real del campo', async () => {
    const doc = await svc.issueReference(payout('wtx-1'))
    expect(Number(doc.reference)).toBeLessThanOrEqual(2_147_483_647)
  })

  test('es solo dígitos, porque ATC manda estos campos sin comillas en sus ejemplos', async () => {
    const doc = await svc.issueReference(payout('wtx-1'))
    expect(doc.reference).toMatch(/^\d{9}$/)
  })

  test('no empieza en cero: si el proveedor lo convierte a número, no se pierde nada', async () => {
    const doc = await svc.issueReference(payout('wtx-1'))
    expect(doc.reference[0]).not.toBe('0')
    expect(String(Number(doc.reference))).toBe(doc.reference)
  })

  test('retiros y cobros viven en bloques distintos', async () => {
    const out = await svc.issueReference(payout('wtx-1'))
    const inn = await svc.issueReference({ ...payout('wtx-1'), kind: 'payin', targetModel: 'Transaction' })

    expect(out.reference.startsWith('1')).toBe(true)
    expect(inn.reference.startsWith('2')).toBe(true)
  })
})

describe('desplazamiento inicial', () => {
  // Un contador que arranca en 1 le informa al proveedor cuántas operaciones
  // llevamos. El desplazamiento lo oculta sin perder la cuenta real.
  test('la primera referencia no delata que es la primera', async () => {
    const doc = await svc.issueReference(payout('wtx-1'))

    const counter = await mongoose.model('Counter').findById('PREF-redenlace-payout')
    expect(counter.seq).toBe(1)                       // la cuenta real sigue ahí
    expect(doc.reference).not.toBe('100000001')       // pero no se publica
    expect(Number(doc.reference) - 100_000_000).toBeGreaterThan(10_000_000)
  })

  test('el desplazamiento se sortea una sola vez y no se mueve después', async () => {
    await svc.issueReference(payout('wtx-1'))
    const Counter = mongoose.model('Counter')
    const base    = (await Counter.findById('PREF-redenlace-payout')).base

    await svc.issueReference(payout('wtx-2'))
    await svc.issueReference(payout('wtx-3'))

    // Si el base cambiara, una serie ya emitida se solaparía con la nueva.
    expect((await Counter.findById('PREF-redenlace-payout')).base).toBe(base)
  })

  test('la serie sigue siendo correlativa: cada alias es el anterior más uno', async () => {
    const a = await svc.issueReference(payout('wtx-1'))
    const b = await svc.issueReference(payout('wtx-2'))

    expect(Number(b.reference) - Number(a.reference)).toBe(1)
  })

  test('dos series distintas no comparten desplazamiento', async () => {
    await svc.issueReference(payout('wtx-1'))
    await svc.issueReference({ ...payout('tx-1'), kind: 'payin', targetModel: 'Transaction' })

    const Counter = mongoose.model('Counter')
    const bases = await Promise.all([
      Counter.findById('PREF-redenlace-payout'),
      Counter.findById('PREF-redenlace-payin'),
    ])
    for (const c of bases) {
      expect(c.base).toBeGreaterThanOrEqual(10_000_000)
      expect(c.base).toBeLessThan(50_000_000)
    }
  })

  test('una serie creada antes de que existiera el desplazamiento no se rompe', async () => {
    // Simula un contador viejo, sin `base`. Sin el `?? 0` esto daría NaN y
    // produciría una referencia inválida en vez de fallar.
    const Counter = mongoose.model('Counter')
    await Counter.create({ _id: 'PREF-redenlace-payout', seq: 41 })

    const doc = await svc.issueReference(payout('wtx-viejo'))

    expect(doc.reference).toBe('100000042')
    expect(doc.reference).toMatch(/^\d{9}$/)
  })
})

describe('unicidad', () => {
  test('dos retiros distintos nunca comparten alias', async () => {
    const a = await svc.issueReference(payout('wtx-1'))
    const b = await svc.issueReference(payout('wtx-2'))
    expect(a.reference).not.toBe(b.reference)
  })

  test('pedir dos veces el alias del mismo retiro devuelve el mismo valor', async () => {
    const a = await svc.issueReference(payout('wtx-1'))
    const b = await svc.issueReference(payout('wtx-1'))

    expect(b.reference).toBe(a.reference)
    expect(await ProviderReference.countDocuments({ targetId: 'wtx-1' })).toBe(1)
  })

  test('dos dispatch simultáneos del mismo retiro resuelven a un solo alias', async () => {
    const [a, b, c] = await Promise.all([
      svc.issueReference(payout('wtx-carrera')),
      svc.issueReference(payout('wtx-carrera')),
      svc.issueReference(payout('wtx-carrera')),
    ])

    expect(new Set([a.reference, b.reference, c.reference]).size).toBe(1)
    expect(await ProviderReference.countDocuments({ targetId: 'wtx-carrera' })).toBe(1)
  })

  test('un cobro sí puede reemitirse: un QR que expira y se regenera es otro cobro', async () => {
    const payin = { provider: 'redenlace', kind: 'payin', targetModel: 'Transaction', targetId: 'ALY-C-1' }
    const a = await svc.issueReference(payin)
    const b = await svc.issueReference(payin)

    expect(a.reference).not.toBe(b.reference)
  })
})

describe('vuelta desde el proveedor', () => {
  test('se resuelve el destino a partir de lo que informa ATC', async () => {
    const doc = await svc.issueReference(payout('wtx-1'))
    await svc.attachExternalReference(doc.reference, '502125545442601')

    const found = await svc.resolveByExternal('redenlace', '502125545442601')

    expect(found.targetId).toBe('wtx-1')
    expect(found.amount).toBe(100)   // para contrastar el importe antes de liquidar
  })

  test('una referencia externa desconocida devuelve null, no el primer registro', async () => {
    await svc.issueReference(payout('wtx-1'))
    expect(await svc.resolveByExternal('redenlace', '999')).toBeNull()
    expect(await svc.resolveByExternal('redenlace', null)).toBeNull()
  })

  test('la misma referencia externa no puede apuntar a dos retiros', async () => {
    const a = await svc.issueReference(payout('wtx-1'))
    const b = await svc.issueReference(payout('wtx-2'))

    await svc.attachExternalReference(a.reference, 'ATC-777')
    await expect(svc.attachExternalReference(b.reference, 'ATC-777'))
      .rejects.toThrow(/duplicate key/i)
  })
})

describe('traducción de la referencia del cobro QR', () => {
  // ATC rechaza `numeroReferencia` con letras:
  //   INVALID_FORMAT — "El número de referencia debe contener solo dígitos numéricos"
  // Verificado contra el sandbox el 2026-09-26. No figura en la documentación.
  let qr, restoreEnv

  beforeAll(async () => {
    qr = await import('../../src/services/bankQr/banks/redenlaceQrService.js')
  })

  beforeEach(() => {
    restoreEnv = { ...process.env }
    process.env.REDENLACE_BASE_URL         = 'https://atcgwapitest.redenlace.com.bo/sandbox'
    process.env.REDENLACE_CLIENT_ID        = 'id-de-prueba'
    process.env.REDENLACE_CLIENT_SECRET    = 'secret-de-prueba'
    process.env.REDENLACE_ESTABLISHMENT_ID = '420056'
    process.env.REDENLACE_QR_WEBHOOK_URL   = 'https://api-staging.alyto.app/api/v1/ipn/redenlace'
    process.env.REDENLACE_QR_WEBHOOK_VALUE = 'secreto'
    delete process.env.REDENLACE_MOCK_ENABLED
  })

  afterEach(() => {
    process.env = restoreEnv
    globalThis.fetch = undefined
  })

  /**
   * fetch falso, ruteado por URL y no por orden de llamada: el cliente cachea
   * el token, así que después de la primera prueba ya no pide autenticación y
   * una cola posicional se desfasaría.
   */
  function stubFetch() {
    const calls = []
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options })
      const body = String(url).includes('/oauth-client-credentials/')
        ? { access_token: 'tok', expires_in: 3600 }
        : { success: true, data: { numeroReferencia: '153980', qr: 'x', fechaExpiracion: '2027-01-01T00:00:00' } }
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
    }
    return calls
  }

  test('un alytoTransactionId con letras se traduce a un alias de solo dígitos', async () => {
    const calls = stubFetch()

    const out = await qr.generateQR({ transactionId: 'ALY-C-1759000000-Ab3xK', amount: 10.5 })

    const body = JSON.parse(calls.find((c) => c.url.includes('/generate')).options.body)
    expect(body.numeroReferencia).toMatch(/^\d+$/)
    expect(body.numeroReferencia).not.toContain('ALY')
    expect(out.numeroReferencia).toBe(body.numeroReferencia)
  })

  test('el alias emitido permite volver a la transacción', async () => {
    stubFetch()
    const out = await qr.generateQR({ transactionId: 'ALY-C-1759000000-Ab3xK', amount: 10.5 })

    const doc = await svc.resolveByReference(out.numeroReferencia)
    expect(doc.targetId).toBe('ALY-C-1759000000-Ab3xK')
    expect(doc.kind).toBe('payin')
  })

  test('una carga de wallet apunta a WalletTransaction, no a Transaction', async () => {
    stubFetch()
    const out = await qr.generateQR({
      transactionId: 'WTX-abc123', amount: 50, targetModel: 'WalletTransaction',
    })

    const doc = await svc.resolveByReference(out.numeroReferencia)
    expect(doc.targetModel).toBe('WalletTransaction')
  })

  test('un identificador ya numérico se manda tal cual, sin gastar un alias', async () => {
    const calls = stubFetch()

    await qr.generateQR({ transactionId: '4024', amount: 1 })

    const body = JSON.parse(calls.find((c) => c.url.includes('/generate')).options.body)
    expect(body.numeroReferencia).toBe('4024')
    expect(await ProviderReference.countDocuments({ kind: 'payin' })).toBe(0)
  })
})

describe('validaciones', () => {
  test('un kind desconocido no produce un alias de formato distinto', async () => {
    await expect(svc.issueReference({ ...payout('wtx-1'), kind: 'transferencia' }))
      .rejects.toThrow()
  })

  test('sin targetId falla antes de consumir un número de la secuencia', async () => {
    await expect(svc.issueReference({ provider: 'redenlace', kind: 'payout', targetModel: 'WalletTransaction' }))
      .rejects.toThrow(/targetId/)

    const Counter = mongoose.model('Counter')
    expect(await Counter.findById('PREF-redenlace-payout')).toBeNull()
  })
})
