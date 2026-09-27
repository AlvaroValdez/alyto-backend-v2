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
    expect(doc.reference).toHaveLength(10)
    expect(doc.reference.length).toBeLessThanOrEqual(14)
  })

  test('es solo dígitos, porque ATC manda estos campos sin comillas en sus ejemplos', async () => {
    const doc = await svc.issueReference(payout('wtx-1'))
    expect(doc.reference).toMatch(/^\d{10}$/)
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
