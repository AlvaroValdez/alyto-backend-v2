/**
 * sep24Closure.test.js — Guardas de cierre de instrucciones SEP-24 caducadas.
 *
 * El riesgo que cubre esta suite es asimétrico: dejar abierta una instrucción
 * caducada solo ensucia el backoffice, pero cerrar una que sí recibió fondos deja
 * al usuario sin acreditar y sin rastro del reclamo. Por eso los casos negativos
 * (todo lo que debe BLOQUEAR el cierre) son los que más importan.
 */

import '../setup.env.js'
import { evaluateSep24Closure } from '../../src/controllers/adminController.js'

const AHORA    = new Date('2026-08-17T12:00:00Z')
const CADUCADA = new Date('2026-06-22T03:00:00Z')
const VIGENTE  = new Date('2026-08-18T12:00:00Z')

/** Instrucción caducada, sin fondos, sin eventos: el caso que sí debe cerrarse. */
const limpia = () => ({
  status:    'sep24_deposit_pending',
  expiresAt: CADUCADA,
  ipnLog:    [],
})

describe('evaluateSep24Closure — casos cerrables', () => {
  test('instrucción de depósito caducada y sin rastro de fondos', () => {
    const r = evaluateSep24Closure(limpia(), AHORA)
    expect(r.safeToCancel).toBe(true)
    expect(r.blockers).toEqual([])
  })

  test('también aplica a instrucciones de retiro', () => {
    const r = evaluateSep24Closure({ ...limpia(), status: 'sep24_withdraw_pending' }, AHORA)
    expect(r.safeToCancel).toBe(true)
  })

  test('ipnLog ausente se trata como sin eventos', () => {
    const { ipnLog, ...sinLog } = limpia()
    expect(evaluateSep24Closure(sinLog, AHORA).safeToCancel).toBe(true)
  })
})

describe('evaluateSep24Closure — bloqueos que protegen al usuario', () => {
  test('transacción Stellar asociada bloquea: pudo haber recibido fondos', () => {
    const r = evaluateSep24Closure({ ...limpia(), stellarTxHash: 'abc123' }, AHORA)
    expect(r.safeToCancel).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/Stellar/)
  })

  test('stellarTxId también bloquea (el campo alterno del mismo dato)', () => {
    expect(evaluateSep24Closure({ ...limpia(), stellarTxId: 'def456' }, AHORA).safeToCancel).toBe(false)
  })

  test('referencia externa del proveedor bloquea', () => {
    const r = evaluateSep24Closure({ ...limpia(), externalTransactionId: 'EXT-1' }, AHORA)
    expect(r.safeToCancel).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/referencia externa/)
  })

  test('cualquier evento en ipnLog bloquea', () => {
    const r = evaluateSep24Closure({ ...limpia(), ipnLog: [{ eventType: 'deposit_received' }] }, AHORA)
    expect(r.safeToCancel).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/1 evento/)
  })

  test('instrucción todavía vigente no se cierra', () => {
    const r = evaluateSep24Closure({ ...limpia(), expiresAt: VIGENTE }, AHORA)
    expect(r.safeToCancel).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/vigente hasta/)
  })

  test('sin fecha de expiración no se puede afirmar que caducó', () => {
    const r = evaluateSep24Closure({ ...limpia(), expiresAt: null }, AHORA)
    expect(r.safeToCancel).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/sin fecha de expiración/)
  })

  test('un estado que no es SEP-24 pendiente nunca se cierra por esta vía', () => {
    for (const status of ['completed', 'payin_confirmed', 'failed', 'cancelled', 'refunded']) {
      const r = evaluateSep24Closure({ ...limpia(), status }, AHORA)
      expect(r.safeToCancel).toBe(false)
      expect(r.blockers.join(' ')).toMatch(/no es una instrucción SEP-24 pendiente/)
    }
  })

  test('acumula todos los bloqueos, no solo el primero', () => {
    const r = evaluateSep24Closure(
      { status: 'completed', expiresAt: VIGENTE, stellarTxHash: 'x', externalTransactionId: 'y', ipnLog: [{}, {}] },
      AHORA,
    )
    expect(r.safeToCancel).toBe(false)
    expect(r.blockers).toHaveLength(5)
  })
})

describe('evaluateSep24Closure — frontera de caducidad', () => {
  test('expira exactamente ahora todavía cuenta como vigente', () => {
    expect(evaluateSep24Closure({ ...limpia(), expiresAt: AHORA }, AHORA).safeToCancel).toBe(false)
  })

  test('expirada un milisegundo antes ya es cerrable', () => {
    const justo = new Date(AHORA.getTime() - 1)
    expect(evaluateSep24Closure({ ...limpia(), expiresAt: justo }, AHORA).safeToCancel).toBe(true)
  })

  test('acepta expiresAt serializado como string ISO', () => {
    const r = evaluateSep24Closure({ ...limpia(), expiresAt: CADUCADA.toISOString() }, AHORA)
    expect(r.safeToCancel).toBe(true)
  })
})

describe('evaluateSep24Closure — los 7 casos reales del 22/06/2026', () => {
  // Reproduce el estado observado en producción: siete instrucciones creadas en
  // una ventana de una hora, todas expiradas el mismo día, ninguna con fondos.
  const reales = [100, 100, 100, 100, 100, 100, 50].map((monto) => ({
    status:         'sep24_deposit_pending',
    sep24Type:      'deposit',
    originalAmount: monto,
    originCurrency: 'USD',
    expiresAt:      new Date('2026-06-22T23:59:59Z'),
    stellarTxHash:  null,
    stellarTxId:    null,
    ipnLog:         [],
  }))

  test('las siete resultan cerrables', () => {
    const evaluadas = reales.map((t) => evaluateSep24Closure(t, AHORA))
    expect(evaluadas.every((r) => r.safeToCancel)).toBe(true)
  })

  test('si una hubiera recibido fondos, solo esa queda fuera', () => {
    const conFondos = [...reales]
    conFondos[3] = { ...conFondos[3], stellarTxHash: 'llegaron_fondos' }
    const cerrables = conFondos.filter((t) => evaluateSep24Closure(t, AHORA).safeToCancel)
    expect(cerrables).toHaveLength(6)
  })
})
