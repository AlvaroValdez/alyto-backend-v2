/**
 * sandboxOnly.test.js — Guard de entorno para endpoints de simulación.
 *
 * Lo que se protege: un endpoint "simulate*" fabrica el efecto de un evento
 * externo que nunca ocurrió (acreditar un depósito, confirmar un payin, cerrar
 * un retiro). Si el guard falla ABIERTO en producción se crea saldo de la nada
 * sobre fondos de terceros bajo custodia — por eso el foco de esta suite es el
 * fail-closed, no el camino feliz.
 *
 * El discriminador NO es `NODE_ENV === 'production'` a secas: Render staging
 * también corre NODE_ENV=production (render.yaml) y ahí los simuladores deben
 * poder habilitarse. La señal autoritativa de producción real es
 * AWS_SECRETS_NAME (mismo criterio que el ProviderGuard de server.js).
 */

import '../setup.env.js'
import {
  areSimulatorsAllowed, isRealProductionEnv, shouldSimulatePayoutConfirmation,
} from '../../src/utils/environment.js'
import { sandboxOnly, denyIfProduction } from '../../src/middlewares/sandboxOnly.js'

const SNAPSHOT = {
  NODE_ENV:                 process.env.NODE_ENV,
  AWS_SECRETS_NAME:         process.env.AWS_SECRETS_NAME,
  ALYTO_SANDBOX_SIMULATORS: process.env.ALYTO_SANDBOX_SIMULATORS,
}

function setEnv({ nodeEnv, secretsName, optIn }) {
  if (nodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = nodeEnv

  if (secretsName === undefined) delete process.env.AWS_SECRETS_NAME
  else process.env.AWS_SECRETS_NAME = secretsName

  if (optIn === undefined) delete process.env.ALYTO_SANDBOX_SIMULATORS
  else process.env.ALYTO_SANDBOX_SIMULATORS = optIn
}

function mockRes() {
  const res = { statusCode: null, body: null }
  res.status = code => { res.statusCode = code; return res }
  res.json   = body => { res.body = body;      return res }
  return res
}

const mockReq = (o = {}) => ({ path: '/admin/x/simulate-y', originalUrl: '/api/v1/admin/x/simulate-y', ...o })

afterEach(() => {
  for (const [k, v] of Object.entries(SNAPSHOT)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('areSimulatorsAllowed — producción real (AWS Secrets Manager presente)', () => {

  test('DENIEGA con cualquier NODE_ENV que no declare desarrollo', () => {
    // AWS_SECRETS_NAME solo lo carga el VPS de producción. Es la señal más
    // fuerte que existe y no admite escape hatch.
    // ⚠️ 'development'/'test' quedan fuera a propósito: el .env local trae
    // AWS_SECRETS_NAME junto a NODE_ENV=development y ahí sí deben permitirse
    // (ver el describe de isRealProductionEnv).
    for (const nodeEnv of ['production', 'staging', 'qa', undefined]) {
      setEnv({ nodeEnv, secretsName: 'alyto/production' })
      expect(areSimulatorsAllowed()).toBe(false)
    }
  })

  test('el opt-in de staging NO puede reabrirlos en producción real', () => {
    setEnv({ nodeEnv: 'production', secretsName: 'alyto/production', optIn: 'true' })
    expect(areSimulatorsAllowed()).toBe(false)
  })
})

describe('areSimulatorsAllowed — fail-closed ante NODE_ENV mal escrito', () => {

  test.each(['Production', 'prod', 'production ', undefined])(
    'NODE_ENV=%p en el host productivo sigue denegado por AWS_SECRETS_NAME',
    nodeEnv => {
      // El bug clásico: comparar exacto contra 'production' y dejar el guard
      // abierto con cualquier variante. Aquí la señal no depende de NODE_ENV.
      setEnv({ nodeEnv, secretsName: 'alyto/production' })
      expect(areSimulatorsAllowed()).toBe(false)
    },
  )
})

describe('areSimulatorsAllowed — Render staging (NODE_ENV=production sin Secrets Manager)', () => {

  test('denegado por defecto', () => {
    setEnv({ nodeEnv: 'production' })
    expect(areSimulatorsAllowed()).toBe(false)
  })

  test('habilitado solo con ALYTO_SANDBOX_SIMULATORS=true exacto', () => {
    setEnv({ nodeEnv: 'production', optIn: 'true' })
    expect(areSimulatorsAllowed()).toBe(true)

    for (const optIn of ['1', 'yes', 'TRUE', 'false', '']) {
      setEnv({ nodeEnv: 'production', optIn })
      expect(areSimulatorsAllowed()).toBe(false)
    }
  })
})

describe('isRealProductionEnv — la señal es positiva, no una negación de NODE_ENV', () => {

  test('AWS_SECRETS_NAME manda cuando NODE_ENV no declara desarrollo', () => {
    setEnv({ nodeEnv: 'production', secretsName: 'alyto/production' })
    expect(isRealProductionEnv()).toBe(true)

    setEnv({ nodeEnv: 'production' })
    expect(isRealProductionEnv()).toBe(false)

    setEnv({ nodeEnv: 'production', secretsName: '' })
    expect(isRealProductionEnv()).toBe(false)
  })

  test('un NODE_ENV de desarrollo tiene prioridad sobre AWS_SECRETS_NAME', () => {
    // El .env del repo trae NODE_ENV=development JUNTO A
    // AWS_SECRETS_NAME=alyto/production (en local se leen los secretos de AWS).
    // Sin esta precedencia, toda máquina de desarrollo quedaba clasificada como
    // el VPS y los simuladores morían en dev.
    for (const nodeEnv of ['development', 'dev', 'test', 'local', 'DEVELOPMENT', ' development ']) {
      setEnv({ nodeEnv, secretsName: 'alyto/production' })
      expect(isRealProductionEnv()).toBe(false)
      expect(areSimulatorsAllowed()).toBe(true)
    }
  })

  test('un NODE_ENV desconocido CON secretos sigue contando como producción', () => {
    // Fail-closed: 'Production', 'prod', 'qa' o vacío no están en la allowlist
    // de desarrollo, así que decide la presencia de secretos.
    for (const nodeEnv of ['Production', 'prod', 'qa', '', undefined]) {
      setEnv({ nodeEnv, secretsName: 'alyto/production' })
      expect(isRealProductionEnv()).toBe(true)
      expect(areSimulatorsAllowed()).toBe(false)
    }
  })
})

describe('areSimulatorsAllowed — dev / test', () => {

  test('permitido sin configurar nada', () => {
    for (const nodeEnv of ['test', 'development', 'staging']) {
      setEnv({ nodeEnv })
      expect(areSimulatorsAllowed()).toBe(true)
    }
  })

  test('AWS_SECRETS_NAME vacío no cuenta como producción', () => {
    // tests/setup.env.js lo deja en '' a propósito para que dotenv no lo repueble.
    setEnv({ nodeEnv: 'test', secretsName: '' })
    expect(areSimulatorsAllowed()).toBe(true)
  })
})

describe('shouldSimulatePayoutConfirmation — autoconfirmación de payouts', () => {

  test('producción real IGNORA VITA_ENVIRONMENT=sandbox', () => {
    // El caso que importa: CLAUDE.md §7 trae VITA_ENVIRONMENT=sandbox en el
    // template, así que copiarlo al VPS convertiría cada payout en una
    // liquidación ficticia con comprobante emitido. Debe caer al camino que
    // espera el IPN real del proveedor.
    setEnv({ nodeEnv: 'production', secretsName: 'alyto/production' })
    expect(shouldSimulatePayoutConfirmation('sandbox')).toBe(false)
  })

  test('en dev/test con sandbox sí autoconfirma (comportamiento preservado)', () => {
    setEnv({ nodeEnv: 'test' })
    expect(shouldSimulatePayoutConfirmation('sandbox')).toBe(true)
  })

  test('sin VITA_ENVIRONMENT=sandbox nunca autoconfirma, ni en dev', () => {
    setEnv({ nodeEnv: 'test' })
    for (const v of ['production', 'Sandbox', '', undefined, 'stage']) {
      expect(shouldSimulatePayoutConfirmation(v)).toBe(false)
    }
  })

  test('Render staging: denegado por defecto, habilitable con el opt-in', () => {
    setEnv({ nodeEnv: 'production' })
    expect(shouldSimulatePayoutConfirmation('sandbox')).toBe(false)

    setEnv({ nodeEnv: 'production', optIn: 'true' })
    expect(shouldSimulatePayoutConfirmation('sandbox')).toBe(true)
  })

  test('lee VITA_ENVIRONMENT del entorno si no se le pasa argumento', () => {
    setEnv({ nodeEnv: 'test' })
    const original = process.env.VITA_ENVIRONMENT
    process.env.VITA_ENVIRONMENT = 'sandbox'
    expect(shouldSimulatePayoutConfirmation()).toBe(true)
    process.env.VITA_ENVIRONMENT = 'production'
    expect(shouldSimulatePayoutConfirmation()).toBe(false)
    if (original === undefined) delete process.env.VITA_ENVIRONMENT
    else process.env.VITA_ENVIRONMENT = original
  })
})

describe('sandboxOnly (middleware)', () => {

  test('bloqueado → 403 SANDBOX_ONLY y NO llama a next()', () => {
    setEnv({ nodeEnv: 'production', secretsName: 'alyto/production' })
    const res = mockRes()
    let nextCalled = false

    sandboxOnly(mockReq({ user: { _id: 'abc', email: 'admin@alyto.app' } }), res, () => { nextCalled = true })

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(403)
    expect(res.body.code).toBe('SANDBOX_ONLY')
  })

  test('permitido → deja pasar sin tocar la respuesta', () => {
    setEnv({ nodeEnv: 'test' })
    const res = mockRes()
    let nextCalled = false

    sandboxOnly(mockReq(), res, () => { nextCalled = true })

    expect(nextCalled).toBe(true)
    expect(res.statusCode).toBeNull()
  })

  test('lee el entorno en cada llamada, no al importar el módulo (regla 21)', () => {
    // El módulo se importó con NODE_ENV=test. Si hubiera capturado el valor en
    // el ámbito de módulo, este flip no tendría efecto y el guard fallaría
    // abierto en producción — que es exactamente el defecto que cierra.
    setEnv({ nodeEnv: 'production', secretsName: 'alyto/production' })
    const res = mockRes()
    sandboxOnly(mockReq(), res, () => {})
    expect(res.statusCode).toBe(403)
  })

  test('el cuerpo de la respuesta no es compartido entre llamadas', () => {
    setEnv({ nodeEnv: 'production', secretsName: 'alyto/production' })
    const a = mockRes(); const b = mockRes()
    sandboxOnly(mockReq(), a, () => {})
    sandboxOnly(mockReq(), b, () => {})
    a.body.code = 'MUTADO'
    expect(b.body.code).toBe('SANDBOX_ONLY')
  })
})

describe('denyIfProduction (guard dentro del handler)', () => {

  test('bloqueado → responde 403 y devuelve true (el caller debe cortar)', () => {
    setEnv({ nodeEnv: 'production', secretsName: 'alyto/production' })
    const res = mockRes()

    expect(denyIfProduction(res, 'simulate-bankqr-payment')).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(res.body.code).toBe('SANDBOX_ONLY')
  })

  test('permitido → devuelve false y no responde', () => {
    setEnv({ nodeEnv: 'test' })
    const res = mockRes()

    expect(denyIfProduction(res, 'simulate-bankqr-payment')).toBe(false)
    expect(res.statusCode).toBeNull()
  })
})
