/**
 * accessLog.test.js — Bloqueo por intentos fallidos y política de umbrales.
 *
 * Cubre la lógica pura del Art. 2° inc. d, Sec. 4 del Reglamento ETF. El riesgo
 * es asimétrico en las dos direcciones: un umbral que nunca bloquea deja la
 * puerta abierta a la fuerza bruta, y uno que bloquea de más deja fuera a un
 * usuario legítimo que se equivocó dos veces. Por eso se prueban ambos bordes.
 */

import '../setup.env.js'
import {
  isLockedOut,
  nextLockoutState,
  maxFailedAttempts,
  lockoutMinutes,
} from '../../src/services/accessLogService.js'

const AHORA = new Date('2026-08-20T12:00:00Z')

describe('isLockedOut', () => {
  test('sin bloqueo previo, la cuenta está habilitada', () => {
    expect(isLockedOut({}, AHORA)).toBe(false)
    expect(isLockedOut({ lockedUntil: null }, AHORA)).toBe(false)
    expect(isLockedOut(undefined, AHORA)).toBe(false)
  })

  test('bloqueo vencido no bloquea', () => {
    const pasado = new Date(AHORA.getTime() - 1000)
    expect(isLockedOut({ lockedUntil: pasado }, AHORA)).toBe(false)
  })

  test('bloqueo vigente sí bloquea', () => {
    const futuro = new Date(AHORA.getTime() + 60_000)
    expect(isLockedOut({ lockedUntil: futuro }, AHORA)).toBe(true)
  })

  test('el instante exacto de vencimiento ya no bloquea', () => {
    // Preferimos liberar un milisegundo antes que dejar fuera a un usuario
    // legítimo: la fuerza bruta no se detiene por un milisegundo, una persona sí
    // se frustra.
    expect(isLockedOut({ lockedUntil: AHORA }, AHORA)).toBe(false)
  })

  test('acepta la fecha serializada como texto', () => {
    const futuro = new Date(AHORA.getTime() + 60_000).toISOString()
    expect(isLockedOut({ lockedUntil: futuro }, AHORA)).toBe(true)
  })
})

describe('nextLockoutState', () => {
  const UMBRAL = maxFailedAttempts()

  test('el primer fallo abre la racha sin bloquear', () => {
    const r = nextLockoutState(0, AHORA)
    expect(r.streak).toBe(1)
    expect(r.lockedUntil).toBeNull()
  })

  test('no bloquea mientras la racha esté por debajo del umbral', () => {
    for (let previo = 0; previo < UMBRAL - 1; previo++) {
      expect(nextLockoutState(previo, AHORA).lockedUntil).toBeNull()
    }
  })

  test('bloquea exactamente al alcanzar el umbral', () => {
    const r = nextLockoutState(UMBRAL - 1, AHORA)
    expect(r.streak).toBe(UMBRAL)
    expect(r.lockedUntil).toBeInstanceOf(Date)
  })

  test('el bloqueo dura lo configurado', () => {
    const r = nextLockoutState(UMBRAL - 1, AHORA)
    const minutos = (r.lockedUntil.getTime() - AHORA.getTime()) / 60_000
    expect(minutos).toBeCloseTo(lockoutMinutes(), 5)
  })

  test('seguir fallando estando bloqueado extiende el bloqueo', () => {
    const r = nextLockoutState(UMBRAL + 3, AHORA)
    expect(r.streak).toBe(UMBRAL + 4)
    expect(r.lockedUntil).toBeInstanceOf(Date)
  })

  test('una racha corrupta no rompe el cálculo', () => {
    for (const basura of [null, undefined, NaN, -7, 'x']) {
      const r = nextLockoutState(basura, AHORA)
      expect(r.streak).toBe(1)
      expect(r.lockedUntil).toBeNull()
    }
  })
})

describe('umbrales configurables', () => {
  const original = { ...process.env }
  afterEach(() => { process.env = { ...original } })

  test('valores por defecto razonables si no hay configuración', () => {
    delete process.env.AUTH_MAX_FAILED_ATTEMPTS
    delete process.env.AUTH_LOCKOUT_MINUTES
    expect(maxFailedAttempts()).toBe(5)
    expect(lockoutMinutes()).toBe(15)
  })

  test('se respeta la configuración válida', () => {
    process.env.AUTH_MAX_FAILED_ATTEMPTS = '3'
    process.env.AUTH_LOCKOUT_MINUTES     = '30'
    expect(maxFailedAttempts()).toBe(3)
    expect(lockoutMinutes()).toBe(30)
  })

  test('una configuración inválida cae al default en vez de desactivar el control', () => {
    // Un valor vacío o basura no puede traducirse en "cero intentos" ni en
    // "bloqueo de cero minutos": ambos desactivarían el control en silencio.
    for (const malo of ['', '0', '-1', 'abc']) {
      process.env.AUTH_MAX_FAILED_ATTEMPTS = malo
      process.env.AUTH_LOCKOUT_MINUTES     = malo
      expect(maxFailedAttempts()).toBe(5)
      expect(lockoutMinutes()).toBe(15)
    }
  })
})
