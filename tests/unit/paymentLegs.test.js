/**
 * paymentLegs.test.js — Coherencia del desglose por etapa.
 *
 * Detectado en la operación real ALY-C-1791276352443-HD5WWD (2026-10-06): cobro
 * BANECO confirmado por IPN y payout aceptado por Vita, pero el desglose decía
 * que el payin seguía 'pending' y no tenía ninguna etapa de payout — mientras
 * `providersUsed` sí listaba `payout:vitaWallet`. Tres registros de la misma
 * transacción contándose historias distintas.
 */

import '../setup.env.js'
import { completePayinLeg, recordPayoutLeg } from '../../src/utils/paymentLegs.js'

/** Doble del documento: sólo necesitamos el array y que mute en memoria. */
const txConPayinPendiente = (provider = 'bankQr') => ({
  paymentLegs: [{ stage: 'payin', provider, status: 'pending', externalId: 'QR-123' }],
})

describe('completePayinLeg', () => {
  test('cierra la etapa con la fecha REAL del banco, no con `now`', () => {
    const tx = txConPayinPendiente()
    const delBanco = new Date('2026-10-06T08:46:40.000Z')

    completePayinLeg(tx, { completedAt: delBanco })

    expect(tx.paymentLegs[0].status).toBe('completed')
    expect(tx.paymentLegs[0].completedAt).toEqual(delBanco)
  })

  test('es idempotente: un IPN repetido no reescribe la fecha del cobro', () => {
    const tx = txConPayinPendiente()
    const primera = new Date('2026-10-06T08:46:40.000Z')
    completePayinLeg(tx, { completedAt: primera })
    completePayinLeg(tx, { completedAt: new Date('2026-10-06T23:00:00.000Z') })

    expect(tx.paymentLegs[0].completedAt).toEqual(primera)
    expect(tx.paymentLegs).toHaveLength(1)
  })

  test('sin etapa de payin la crea — el desglose no debe mentir por omisión', () => {
    const tx = { paymentLegs: [] }
    completePayinLeg(tx, { provider: 'manual', externalId: 'REF-9' })

    expect(tx.paymentLegs).toHaveLength(1)
    expect(tx.paymentLegs[0]).toEqual(expect.objectContaining({
      stage: 'payin', provider: 'manual', status: 'completed', externalId: 'REF-9',
    }))
  })

  test('completa el externalId si faltaba, sin pisar el existente', () => {
    const tx = txConPayinPendiente()
    completePayinLeg(tx, { externalId: 'OTRO' })
    expect(tx.paymentLegs[0].externalId).toBe('QR-123')   // no lo pisa

    const sinRef = { paymentLegs: [{ stage: 'payin', status: 'pending' }] }
    completePayinLeg(sinRef, { externalId: 'NUEVO' })
    expect(sinRef.paymentLegs[0].externalId).toBe('NUEVO')
  })

  test('tolera documentos sin el array y no explota con null', () => {
    const sinArray = {}
    completePayinLeg(sinArray, { provider: 'bankQr' })
    expect(sinArray.paymentLegs).toHaveLength(1)
    expect(() => completePayinLeg(null)).not.toThrow()
  })
})

describe('recordPayoutLeg', () => {
  test('registra el payout como processing: aceptado por el proveedor, no acreditado', () => {
    const tx = txConPayinPendiente()
    recordPayoutLeg(tx, { provider: 'vitaWallet', externalId: 'd5905dd9' })

    expect(tx.paymentLegs).toHaveLength(2)
    expect(tx.paymentLegs[1]).toEqual({
      stage: 'payout', provider: 'vitaWallet', status: 'processing', externalId: 'd5905dd9',
    })
  })

  test('un reintento ACTUALIZA la etapa en vez de apilar duplicados', () => {
    const tx = { paymentLegs: [] }
    recordPayoutLeg(tx, { provider: 'owlPay', externalId: 'T1' })
    recordPayoutLeg(tx, { provider: 'owlPay', status: 'completed', externalId: 'T1', completedAt: new Date() })

    expect(tx.paymentLegs.filter(l => l.stage === 'payout')).toHaveLength(1)
    expect(tx.paymentLegs[0].status).toBe('completed')
    expect(tx.paymentLegs[0].completedAt).toBeInstanceOf(Date)
  })

  test('dos proveedores distintos SÍ conviven (fallback de riel)', () => {
    const tx = { paymentLegs: [] }
    recordPayoutLeg(tx, { provider: 'vitaWallet', status: 'failed' })
    recordPayoutLeg(tx, { provider: 'owlPay', status: 'processing' })
    expect(tx.paymentLegs).toHaveLength(2)
  })

  test('sin proveedor no inventa una etapa anónima', () => {
    const tx = { paymentLegs: [] }
    recordPayoutLeg(tx, {})
    expect(tx.paymentLegs).toHaveLength(0)
  })
})

describe('el caso real completo (ALY-C-…-HD5WWD)', () => {
  test('el desglose termina coherente con providersUsed e ipnLog', () => {
    // Nace con el payin pendiente, como lo crea initCrossBorderPayment.
    const tx = txConPayinPendiente()

    // IPN del banco: cobro confirmado a las 08:46:40.
    completePayinLeg(tx, { completedAt: new Date('2026-10-06T08:46:40.000Z') })
    // Vita acepta el payout a las 08:46:54.
    recordPayoutLeg(tx, { provider: 'vitaWallet', externalId: 'd5905dd9-08f7-4038-a1a8-b6464603d801' })

    expect(tx.paymentLegs.map(l => `${l.stage}:${l.status}`))
      .toEqual(['payin:completed', 'payout:processing'])

    // Y al liquidar Vita, la etapa cierra.
    recordPayoutLeg(tx, { provider: 'vitaWallet', status: 'completed', completedAt: new Date() })
    expect(tx.paymentLegs.map(l => `${l.stage}:${l.status}`))
      .toEqual(['payin:completed', 'payout:completed'])
  })
})
