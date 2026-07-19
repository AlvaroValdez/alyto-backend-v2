/**
 * adminAudit.test.js — Lógica pura de la auditoría de acciones admin.
 *
 * Cubre lo más costoso si falla en silencio: (1) que un secreto NUNCA se persista
 * en el audit, y (2) que el registro conserve el snapshot del actor y el before/after.
 */

import '../setup.env.js'
import { redactSensitive, buildAuditRecord } from '../../src/services/adminAuditService.js'

describe('redactSensitive', () => {
  test('redacta campos sensibles por nombre (varias variantes)', () => {
    const input = {
      publicKey: 'GABC...',
      secretKey: 'SXXXX',
      STELLAR_SRL_SECRET_KEY: 'SYYYY',
      password: 'hunter2',
      aesKey: 'deadbeef',
      api_key: 'k_123',
      privateKey: 'p',
      mnemonic: 'word word',
      token: 'jwt.abc',
      secretKeyCiphertext: 'cipher',
      amount: 100,
    }
    const out = redactSensitive(input)
    expect(out.publicKey).toBe('GABC...')      // público, no se toca
    expect(out.amount).toBe(100)
    for (const k of ['secretKey', 'STELLAR_SRL_SECRET_KEY', 'password', 'aesKey', 'api_key', 'privateKey', 'mnemonic', 'token', 'secretKeyCiphertext']) {
      expect(out[k]).toBe('[REDACTED]')
    }
  })

  test('redacta en objetos anidados y arrays', () => {
    const out = redactSensitive({
      user: { email: 'a@b.com', stellarAccount: { publicKey: 'G1', secretKeyCiphertext: 'X' } },
      keys: [{ secret: 's1' }, { secret: 's2' }],
    })
    expect(out.user.email).toBe('a@b.com')
    expect(out.user.stellarAccount.publicKey).toBe('G1')
    expect(out.user.stellarAccount.secretKeyCiphertext).toBe('[REDACTED]')
    expect(out.keys[0].secret).toBe('[REDACTED]')
    expect(out.keys[1].secret).toBe('[REDACTED]')
  })

  test('maneja null/undefined/primitivos sin romper', () => {
    expect(redactSensitive(null)).toBeNull()
    expect(redactSensitive(undefined)).toBeUndefined()
    expect(redactSensitive(42)).toBe(42)
    expect(redactSensitive('x')).toBe('x')
  })

  test('serializa Date a ISO y corta la recursión muy profunda', () => {
    const d = new Date('2026-07-18T00:00:00.000Z')
    expect(redactSensitive({ at: d }).at).toBe('2026-07-18T00:00:00.000Z')
    // Estructura muy anidada → no lanza, trunca
    let deep = {}; let cur = deep
    for (let i = 0; i < 20; i++) { cur.next = {}; cur = cur.next }
    expect(() => redactSensitive(deep)).not.toThrow()
  })
})

describe('buildAuditRecord', () => {
  const actor = { _id: 'aid1', email: 'admin@alyto.app', role: 'admin' }

  test('toma snapshot del actor y normaliza campos', () => {
    const r = buildAuditRecord({
      actor, action: 'fee.update', targetType: 'WalletFeeConfig', targetId: 'singleton',
      before: { usdcP2pFeePercent: 1 }, after: { usdcP2pFeePercent: 2 },
    })
    expect(r).toMatchObject({
      actorId: 'aid1', actorEmail: 'admin@alyto.app', actorRole: 'admin',
      action: 'fee.update', targetType: 'WalletFeeConfig', targetId: 'singleton',
      result: 'success',
    })
    expect(r.before).toEqual({ usdcP2pFeePercent: 1 })
    expect(r.after).toEqual({ usdcP2pFeePercent: 2 })
  })

  test('redacta secretos que se colaran en before/after/metadata', () => {
    const r = buildAuditRecord({
      actor, action: 'wallet.freeze',
      before: { status: 'active', secretKeyCiphertext: 'X' },
      after:  { status: 'frozen' },
      metadata: { aesKey: 'leak', oficio: 'ASFI-123' },
    })
    expect(r.before.secretKeyCiphertext).toBe('[REDACTED]')
    expect(r.before.status).toBe('active')
    expect(r.metadata.aesKey).toBe('[REDACTED]')
    expect(r.metadata.oficio).toBe('ASFI-123')
  })

  test('targetId numérico se serializa a string; action es obligatorio', () => {
    expect(buildAuditRecord({ actor, action: 'x', targetId: 42 }).targetId).toBe('42')
    expect(() => buildAuditRecord({ actor, action: '' })).toThrow(/action/)
  })

  test('sin actor, no rompe (campos vacíos)', () => {
    const r = buildAuditRecord({ action: 'x' })
    expect(r.actorId).toBeNull()
    expect(r.actorEmail).toBe('')
  })
})
