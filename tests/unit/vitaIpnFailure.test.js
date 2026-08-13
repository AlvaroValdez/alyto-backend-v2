/**
 * vitaIpnFailure.test.js — Rechazos de Vita que llegan por IPN (2026-08-12).
 *
 * El handler solo reconocía 'denied' y escribía un string fijo, descartando el
 * body. Con cualquier otra palabra la transacción se quedaba en payout_sent sin
 * estado, sin motivo y sin aviso: el admin veía una transacción viva que Vita ya
 * había rechazado. Estos tests fijan que el motivo NUNCA se pierda.
 */

import '../setup.env.js'
import {
  classifyVitaIpnStatus, mapVitaIpnFailure,
  VITA_IPN_FAILURE_STATUSES, VITA_IPN_PROGRESS_STATUSES,
} from '../../src/utils/vitaErrorMapper.js'

describe('classifyVitaIpnStatus', () => {
  test('reconoce el éxito', () => {
    expect(classifyVitaIpnStatus('completed')).toBe('success')
  })

  test('reconoce como fallo TODA palabra terminal, no solo "denied"', () => {
    for (const s of ['denied', 'rejected', 'failed', 'canceled', 'returned', 'reversed']) {
      expect(classifyVitaIpnStatus(s)).toBe('failure')
    }
  })

  test('distingue los estados intermedios (no son fallo)', () => {
    for (const s of ['pending', 'processing', 'in_process']) {
      expect(classifyVitaIpnStatus(s)).toBe('progress')
    }
  })

  test('tolera mayúsculas y espacios', () => {
    expect(classifyVitaIpnStatus('  REJECTED ')).toBe('failure')
    expect(classifyVitaIpnStatus('Completed')).toBe('success')
  })

  test('lo que no conoce queda "unknown" — no se asume nada', () => {
    expect(classifyVitaIpnStatus('en_revision')).toBe('unknown')
    expect(classifyVitaIpnStatus(undefined)).toBe('unknown')
    expect(classifyVitaIpnStatus(null)).toBe('unknown')
  })

  test('los dos sets no se solapan (un estado no puede ser fallo y progreso)', () => {
    for (const s of VITA_IPN_FAILURE_STATUSES) expect(VITA_IPN_PROGRESS_STATUSES.has(s)).toBe(false)
  })
})

describe('mapVitaIpnFailure — el motivo real llega al admin', () => {
  test('extrae el motivo del body en vez del string fijo de antes', () => {
    const m = mapVitaIpnFailure({
      status: 'rejected', order: 'ALY-C-1',
      rejection_reason: 'Cuenta del beneficiario cerrada',
    })
    expect(m.reason).toBe('Cuenta del beneficiario cerrada')
    expect(m.adminMessage).toContain('Cuenta del beneficiario cerrada')
    expect(m.adminMessage).toContain('rejected')   // el estado crudo de Vita, visible
    expect(m.vitaStatus).toBe('rejected')
  })

  test('encuentra el motivo aunque venga anidado', () => {
    const m = mapVitaIpnFailure({
      status: 'denied',
      transaction: { detail: { description: 'IBAN inválido para el país destino' } },
    })
    expect(m.reason).toBe('IBAN inválido para el país destino')
  })

  test('captura el código cuando Vita lo manda', () => {
    const m = mapVitaIpnFailure({ status: 'denied', code: 305, message: 'campo inválido' })
    expect(m.vitaCode).toBe('305')
    expect(m.adminMessage).toContain('code=305')
  })

  test('sin motivo NO se pierde nada: se guarda el body crudo', () => {
    const m = mapVitaIpnFailure({ status: 'denied', order: 'ALY-C-1', wallet: { uuid: 'abc' } })
    expect(m.reason).toBeNull()
    expect(m.adminMessage).toContain('ALY-C-1')   // el body va entero al admin
    expect(m.adminMessage).toContain('denied')
  })

  test('un body vacío deja constancia explícita en vez de un mensaje en blanco', () => {
    const m = mapVitaIpnFailure({})
    expect(m.adminMessage).toContain('Vita no envió motivo')
  })

  test('el body crudo se acota — un payload enorme no revienta el campo', () => {
    const m = mapVitaIpnFailure({ status: 'denied', blob: 'x'.repeat(5000) })
    expect(m.adminMessage.length).toBeLessThan(600)
  })

  test('reusa la clasificación del dispatch: un rechazo de campo da el mismo mensaje al usuario', () => {
    const m = mapVitaIpnFailure({
      status: 'denied', code: 305,
      details: { field: 'account_bank', message: 'Solo se permiten números.' },
    })
    expect(m.category).toBe('VITA_INVALID_FIELD')
    expect(m.userMessage).toMatch(/número de cuenta/)
    expect(m.retryable).toBe(true)
  })

  test('si no se puede clasificar, la categoría nombra el estado real de Vita', () => {
    const m = mapVitaIpnFailure({ status: 'returned', reason: 'devuelto por el banco receptor' })
    expect(m.category).toBe('VITA_IPN_RETURNED')
    expect(m.userMessage).toBeTruthy()    // el usuario siempre recibe algo legible
    expect(m.userAction).toBeTruthy()
  })

  test('distingue payin de payout en el mensaje al admin', () => {
    const body = { status: 'denied', reason: 'x' }
    expect(mapVitaIpnFailure(body, { stage: 'payin'  }).adminMessage).toMatch(/^Payin/)
    expect(mapVitaIpnFailure(body, { stage: 'payout' }).adminMessage).toMatch(/^Payout/)
  })
})
