/**
 * bankDisbursementRegistry.test.js — Costura bank-agnostic de la salida de dinero.
 *
 * Lo que se protege: que `adminDispatchWithdrawal` deje de conocer un banco concreto.
 * Antes importaba `becDisbursementService` directamente, así que sumar el proveedor
 * que sí dispersa (BANECO confirmó el 2026-06-25 que su §9 no existe) obligaba a
 * ramificar en el controlador. La costura es `getDisbursementAdapter`.
 *
 * Dos invariantes que importan más que el ruteo:
 *   - `capabilities.disburse` describe al BANCO, no al código. Que exista cliente
 *     escrito no autoriza a declarar que el riel existe.
 *   - un proveedor desconocido resuelve a null, no a un adapter por descarte: caer
 *     silenciosamente en otro banco sería dispersar dinero por donde nadie pidió.
 */

import '../setup.env.js'
import {
  getBankAdapter,
  getDisbursementAdapter,
  listDisbursementProviders,
  listProviders,
  resolveDisbursementProvider,
} from '../../src/services/bank/bankRegistry.js'

const SNAPSHOT = { WALLET_DISBURSEMENT_PROVIDER: process.env.WALLET_DISBURSEMENT_PROVIDER }

afterEach(() => {
  if (SNAPSHOT.WALLET_DISBURSEMENT_PROVIDER === undefined) delete process.env.WALLET_DISBURSEMENT_PROVIDER
  else process.env.WALLET_DISBURSEMENT_PROVIDER = SNAPSHOT.WALLET_DISBURSEMENT_PROVIDER
})

describe('bankRegistry — proveedor de dispersión', () => {
  test('el default es baneco y sale de env, no de un const de módulo', () => {
    delete process.env.WALLET_DISBURSEMENT_PROVIDER
    expect(resolveDisbursementProvider()).toBe('baneco')

    // Regla 21: leído dentro de la función, así que un cambio posterior a la carga
    // de Secrets Manager se refleja sin reimportar el módulo.
    process.env.WALLET_DISBURSEMENT_PROVIDER = 'otro-banco'
    expect(resolveDisbursementProvider()).toBe('otro-banco')
  })

  test('un proveedor vacío cae al default en vez de resolver a cadena vacía', () => {
    process.env.WALLET_DISBURSEMENT_PROVIDER = ''
    expect(resolveDisbursementProvider()).toBe('baneco')
  })

  test('baneco expone el bloque completo de dispersión', () => {
    const resolved = getDisbursementAdapter('baneco')
    expect(resolved).not.toBeNull()
    expect(resolved.provider).toBe('baneco')
    for (const fn of ['transfer', 'verifyNotifyStatus', 'mapNotifyStatus', 'isAvailable', 'isEnabled']) {
      expect(typeof resolved.disbursement[fn]).toBe('function')
    }
  })

  test('un proveedor desconocido resuelve a null, nunca a otro banco', () => {
    expect(getDisbursementAdapter('redenlace')).toBeNull()
    expect(getDisbursementAdapter('inexistente')).toBeNull()

    process.env.WALLET_DISBURSEMENT_PROVIDER = 'inexistente'
    expect(getDisbursementAdapter()).toBeNull()
  })

  test('capabilities.disburse describe al banco, no al cliente que escribimos', () => {
    // BANECO tiene cliente escrito (gated OFF + mock) pero NO ofrece el riel.
    expect(getDisbursementAdapter('baneco')).not.toBeNull()
    expect(getBankAdapter('baneco').capabilities.disburse).toBe(false)
  })

  test('listDisbursementProviders es un subconjunto de listProviders', () => {
    const all  = listProviders()
    const disb = listDisbursementProviders()
    expect(disb.every((p) => all.includes(p))).toBe(true)
    expect(disb).toContain('baneco')
  })

  test('el adapter expone la consulta de saldo tolerante a fallos del pre-check', () => {
    expect(typeof getBankAdapter('baneco').tryGetAvailableBalance).toBe('function')
  })
})

describe('bankRegistry — mapeo de estados de confirmación', () => {
  test('baneco traduce ACEP/RECH y no inventa un estado ante lo desconocido', () => {
    const { mapNotifyStatus } = getDisbursementAdapter('baneco').disbursement
    expect(mapNotifyStatus('ACEP')).toBe('accepted')
    expect(mapNotifyStatus('RECH')).toBe('rejected')
    expect(mapNotifyStatus('OTRO')).toBe('unknown')
    expect(mapNotifyStatus(undefined)).toBe('unknown')
  })
})
