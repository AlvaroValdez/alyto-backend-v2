/**
 * admin2fa.test.js (unidad) — Lógica pura del segundo factor de autenticación.
 *
 * Cubre el Art. 2° inc. c, Sec. 4 del Reglamento para ETF. Se separa en dos
 * archivos con el mismo nombre de conjunto: aquí lo que se puede probar sin base
 * de datos —el cálculo del código y la depuración de secretos—, y en
 * tests/integration/admin2fa.test.js el ciclo completo contra la base.
 *
 * Criterio del apdo. 13.2.3: los casos borde, no el camino feliz. En un segundo
 * factor los bordes son la ventana de tolerancia y la reutilización — un código
 * que vale un minuto de más, o que vale dos veces, es un código que sirve a quien
 * lo interceptó.
 */

import '../setup.env.js'
import jwt from 'jsonwebtoken'
import {
  generateTotp, verifyTotp, generateSecret, timeStep,
  base32Encode, base32Decode, otpauthUri, formatSecretForManualEntry,
  TOTP_STEP_SECONDS, TOTP_WINDOW, TOTP_DIGITS,
} from '../../src/utils/totp.js'
import { redactSensitive, buildAuditRecord } from '../../src/services/adminAuditService.js'
import {
  hasConfirmedSecondFactor, requiresTwoFactor, isAdminTwoFactorEnabled,
  normalizeRecoveryCode,
} from '../../src/services/adminTwoFactorService.js'
import {
  generateChallengeToken, verifyChallengeToken, claimsProveSecondFactor,
  CHALLENGE_PURPOSE, AMR_PASSWORD, AMR_OTP, AMR_RECOVERY_CODE,
} from '../../src/services/authTokenService.js'

// ─── El cálculo del código: vectores del propio RFC ───────────────────────────

describe('TOTP — vectores de prueba del RFC 6238, Apéndice B', () => {
  // La semilla del RFC es la cadena ASCII '12345678901234567890'.
  const SEMILLA = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

  // [instante T en segundos, código esperado de 8 dígitos]
  const VECTORES = [
    [59,          '94287082'],
    [1111111109,  '07081804'],
    [1111111111,  '14050471'],
    [1234567890,  '89005924'],
    [2000000000,  '69279037'],
    [20000000000, '65353130'],
  ]

  test.each(VECTORES)('T=%i produce %s', (T, esperado) => {
    expect(generateTotp(SEMILLA, { step: Math.floor(T / 30), digits: 8 })).toBe(esperado)
  })

  test('el último vector excede los 32 bits del contador y aun así calcula bien', () => {
    // T=20000000000 da un contador de 666666666, que cabe en 32 bits, pero el
    // instante en milisegundos no: si se usara aritmética de bits de JavaScript
    // en vez de BigInt, este vector saldría mal. Está aquí como centinela.
    expect(generateTotp(SEMILLA, { step: timeStep(20000000000 * 1000), digits: 8 })).toBe('65353130')
  })

  test('los seis dígitos de producción son la cola de los ocho del RFC', () => {
    expect(generateTotp(SEMILLA, { step: Math.floor(59 / 30) })).toBe('287082')
  })
})

// ─── La ventana de tolerancia: el borde que define cuánto vale un código ──────

describe('verifyTotp — ventana de tolerancia', () => {
  const SECRETO = generateSecret()
  const PASO    = 58_000_000   // un paso cualquiera, fijo para que la prueba no dependa del reloj

  test('el valor declarado de la ventana es un paso a cada lado', () => {
    // Si alguien la sube, esta prueba lo obliga a actualizar también la
    // declaración del informe. El valor documentado y el vigente no pueden
    // separarse en silencio.
    expect(TOTP_WINDOW).toBe(1)
    expect(TOTP_STEP_SECONDS).toBe(30)
    expect(TOTP_DIGITS).toBe(6)
  })

  test('el código del paso actual se acepta', () => {
    const code = generateTotp(SECRETO, { step: PASO })
    expect(verifyTotp(SECRETO, code, { step: PASO })).toBe(PASO)
  })

  test('un paso hacia atrás y uno hacia adelante se aceptan', () => {
    for (const delta of [-1, 1]) {
      const code = generateTotp(SECRETO, { step: PASO + delta })
      expect(verifyTotp(SECRETO, code, { step: PASO })).toBe(PASO + delta)
    }
  })

  test('DOS pasos fuera del rango de tolerancia se rechazan', () => {
    // El caso que exige el enunciado: código válido, pero de una ventana que ya
    // no está en tolerancia. Es la diferencia entre 90 segundos de vigencia y
    // dos minutos y medio.
    for (const delta of [-2, 2, -5, 5]) {
      const code = generateTotp(SECRETO, { step: PASO + delta })
      expect(verifyTotp(SECRETO, code, { step: PASO })).toBeNull()
    }
  })

  test('el paso devuelto identifica cuál coincidió, no sólo que hubo coincidencia', () => {
    // Sin este dato no se puede impedir la reutilización: habría que confiar en
    // el reloj del servidor para saber qué código se acaba de gastar.
    const code = generateTotp(SECRETO, { step: PASO - 1 })
    expect(verifyTotp(SECRETO, code, { step: PASO })).toBe(PASO - 1)
  })

  test('la basura se rechaza sin lanzar', () => {
    for (const malo of [null, undefined, '', '12345', '1234567', 'abcdef', '12 34 56', {}, 123456]) {
      expect(verifyTotp(SECRETO, malo, { step: PASO })).toBeNull()
    }
  })

  test('el código de OTRO secreto no vale', () => {
    const otro = generateSecret()
    const code = generateTotp(otro, { step: PASO })
    expect(verifyTotp(SECRETO, code, { step: PASO })).toBeNull()
  })
})

// ─── Base32 y aprovisionamiento ───────────────────────────────────────────────

describe('base32 y URI de aprovisionamiento', () => {
  test('ida y vuelta conserva los bytes', () => {
    const bytes = Buffer.from([0, 1, 127, 128, 255, 42, 17])
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true)
  })

  test('tolera lo que produce un ingreso manual: minúsculas, espacios y relleno', () => {
    const secreto = generateSecret()
    const tecleado = formatSecretForManualEntry(secreto).toLowerCase() + '==='
    expect(base32Decode(tecleado).equals(base32Decode(secreto))).toBe(true)
  })

  test('un carácter fuera del alfabeto no se ignora en silencio', () => {
    // Ignorarlo produciría un secreto distinto del que el operador cree tener, y
    // el fallo aparecería recién al verificar, sin explicación.
    expect(() => base32Decode('ABC!DEF')).toThrow(/base32/i)
  })

  test('el secreto generado tiene 160 bits', () => {
    expect(base32Decode(generateSecret())).toHaveLength(20)
  })

  test('dos secretos consecutivos no coinciden', () => {
    expect(generateSecret()).not.toBe(generateSecret())
  })

  test('el URI declara los parámetros que se usan de verdad', () => {
    const uri = otpauthUri({ secret: 'ABCDEFGH', account: 'admin@alyto.app', issuer: 'Alyto' })
    expect(uri).toMatch(/^otpauth:\/\/totp\/Alyto:admin%40alyto\.app\?/)
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
    expect(uri).toContain('algorithm=SHA1')
  })
})

// ─── Estado del factor y alcance del control ──────────────────────────────────

describe('alcance del control', () => {
  const original = process.env.ADMIN_2FA_ENABLED
  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_2FA_ENABLED
    else process.env.ADMIN_2FA_ENABLED = original
  })

  test('la bandera está apagada por defecto', () => {
    delete process.env.ADMIN_2FA_ENABLED
    expect(isAdminTwoFactorEnabled()).toBe(false)
  })

  test('sólo el valor exacto "true" la enciende', () => {
    for (const valor of ['1', 'yes', 'TRUE', 'si', '']) {
      process.env.ADMIN_2FA_ENABLED = valor
      expect(isAdminTwoFactorEnabled()).toBe(false)
    }
    process.env.ADMIN_2FA_ENABLED = 'true'
    expect(isAdminTwoFactorEnabled()).toBe(true)
  })

  test('el consumidor financiero queda fuera aunque la bandera esté encendida', () => {
    // Restricción explícita del alcance: el segundo factor es para accesos con
    // privilegios de administración. Exigírselo al consumidor sería cambiar el
    // comportamiento de su autenticación, que la tarea prohíbe.
    process.env.ADMIN_2FA_ENABLED = 'true'
    expect(requiresTwoFactor({ role: 'user' })).toBe(false)
    expect(requiresTwoFactor({ role: 'admin' })).toBe(true)
  })

  test('con la bandera apagada no se exige ni a los administradores', () => {
    process.env.ADMIN_2FA_ENABLED = 'false'
    expect(requiresTwoFactor({ role: 'admin' })).toBe(false)
  })

  test('un secreto generado y NO confirmado no habilita nada', () => {
    expect(hasConfirmedSecondFactor({ twoFactor: { enabled: false, confirmedAt: null } })).toBe(false)
    expect(hasConfirmedSecondFactor({ twoFactor: { enabled: true,  confirmedAt: null } })).toBe(false)
    expect(hasConfirmedSecondFactor({ twoFactor: { enabled: false, confirmedAt: new Date() } })).toBe(false)
    expect(hasConfirmedSecondFactor({ twoFactor: { enabled: true,  confirmedAt: new Date() } })).toBe(true)
    expect(hasConfirmedSecondFactor({})).toBe(false)
    expect(hasConfirmedSecondFactor(undefined)).toBe(false)
  })

  test('el código de recuperación se normaliza como lo teclea una persona', () => {
    expect(normalizeRecoveryCode(' ab3d5-xy7z9 ')).toBe('AB3D5XY7Z9')
    expect(normalizeRecoveryCode(null)).toBe('')
  })
})

// ─── La credencial intermedia no puede valer como sesión ──────────────────────

describe('credencial intermedia del segundo factor', () => {
  test('lleva un propósito declarado, que es lo que permite rechazarla como sesión', () => {
    const token = generateChallengeToken({ userId: 'abc123', tokenVersion: 4 })
    expect(jwt.decode(token).purpose).toBe(CHALLENGE_PURPOSE)
  })

  test('se verifica y devuelve el titular y su versión de credencial', () => {
    const token = generateChallengeToken({ userId: 'abc123', tokenVersion: 4, enrollmentRequired: true })
    expect(verifyChallengeToken(token)).toEqual({
      id: 'abc123', tokenVersion: 4, enrollmentRequired: true,
    })
  })

  test('una sesión normal NO pasa por el verificador de credencial intermedia', () => {
    const sesion = jwt.sign({ id: 'abc123', tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })
    expect(verifyChallengeToken(sesion)).toBeNull()
  })

  test('token ausente, vacío o con otra firma se rechazan', () => {
    expect(verifyChallengeToken(null)).toBeNull()
    expect(verifyChallengeToken('')).toBeNull()
    expect(verifyChallengeToken('no-es-un-token')).toBeNull()
    const ajeno = jwt.sign({ id: 'x', purpose: CHALLENGE_PURPOSE }, 'otra-clave-distinta')
    expect(verifyChallengeToken(ajeno)).toBeNull()
  })

  test('sólo acredita segundo factor la sesión que lleva la marca del factor', () => {
    expect(claimsProveSecondFactor({ amr: [AMR_PASSWORD] })).toBe(false)
    expect(claimsProveSecondFactor({ amr: [AMR_PASSWORD, AMR_OTP] })).toBe(true)
    expect(claimsProveSecondFactor({ amr: [AMR_PASSWORD, AMR_RECOVERY_CODE] })).toBe(true)
    // Las sesiones emitidas antes de este control no tienen la reclamación: al
    // encender la bandera quedan fuera del panel, que es lo que se busca.
    expect(claimsProveSecondFactor({})).toBe(false)
    expect(claimsProveSecondFactor({ amr: 'otp' })).toBe(false)
    expect(claimsProveSecondFactor(undefined)).toBe(false)
  })
})

// ─── El secreto no puede aparecer en las bitácoras (apdo. 7.8) ────────────────

describe('depuración de secretos por denominación de campo', () => {
  test('los nombres del segundo factor se depuran', () => {
    const sucio = {
      totpSecret:       'JBSWY3DPEHPK3PXP',
      secretCiphertext: 'v1:AAAA',
      recoveryCodes:    ['AB3D5-XY7Z9'],
      recovery_code:    'AB3D5-XY7Z9',
      twoFactor:        { enabled: true, secretCiphertext: 'v1:AAAA' },
      otpauthUri:       'otpauth://totp/Alyto:admin@alyto.app?secret=JBSWY3DPEHPK3PXP',
      '2faSecret':      'JBSWY3DPEHPK3PXP',
    }
    const limpio = redactSensitive(sucio)

    for (const clave of Object.keys(sucio)) {
      expect(limpio[clave]).toBe('[REDACTED]')
    }
    expect(JSON.stringify(limpio)).not.toContain('JBSWY3DPEHPK3PXP')
    expect(JSON.stringify(limpio)).not.toContain('AB3D5')
  })

  test('el secreto tampoco sobrevive anidado en un registro de auditoría', () => {
    const registro = buildAuditRecord({
      action: 'admin_2fa.reset',
      before: { twoFactor: { secretCiphertext: 'v1:SECRETO', recoveryCodes: ['AB3D5-XY7Z9'] } },
      after:  { enabled: false },
      metadata: { debug: { totp: 'JBSWY3DPEHPK3PXP' } },
    })
    const serializado = JSON.stringify(registro)
    expect(serializado).not.toContain('v1:SECRETO')
    expect(serializado).not.toContain('JBSWY3DPEHPK3PXP')
    expect(serializado).not.toContain('AB3D5')
  })

  test('lo que SÍ debe verse en la bitácora no se depura de más', () => {
    // Una depuración que se lleve puesto el estado del control dejaría el
    // registro sin contenido: hay que poder leer qué cambió.
    const limpio = redactSensitive({ enabled: false, confirmedAt: null, recoveryRemaining: 0 })
    expect(limpio).toEqual({ enabled: false, confirmedAt: null, recoveryRemaining: 0 })
  })
})
