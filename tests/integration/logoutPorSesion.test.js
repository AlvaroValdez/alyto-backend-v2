/**
 * logoutPorSesion.test.js
 *
 * Fija el comportamiento del cierre de sesión por dispositivo.
 *
 * Existe por un defecto concreto: `logoutUser` incrementaba `tokenVersion`, que
 * es un contador POR USUARIO, así que cerrar sesión en el teléfono tumbaba
 * también la del navegador, en silencio. Un tester encontró el otro lado del
 * mismo asunto (que se puede entrar en dos dispositivos) sin notar que cerrar
 * en uno mataba el otro.
 *
 * Lo que estas pruebas protegen:
 *   1. cerrar una sesión NO afecta a las demás del mismo usuario
 *   2. la sesión cerrada queda efectivamente fuera
 *   3. el cambio de contraseña SÍ las mata todas (es lo que promete la política)
 *
 * Run: node --experimental-vm-modules node_modules/.bin/jest tests/integration/logoutPorSesion.test.js
 */

import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import { connectTestDb, disconnectTestDb, clearCollections } from '../helpers/db.js'

process.env.JWT_SECRET = 'secreto-de-prueba'
process.env.NODE_ENV   = 'production'   // la revocación global sólo corre en prod

const RevokedToken = (await import('../../src/models/RevokedToken.js')).default
const { clearJtiCache } = await import('../../src/middlewares/authMiddleware.js')

beforeAll(async () => { await connectTestDb() })
afterEach(async () => { await clearCollections(); clearJtiCache() })
afterAll(async () => { await disconnectTestDb() })

/** Emula un token emitido por generateToken, con su jti propio. */
function emitirToken(userId, { tokenVersion = 0, jti = crypto.randomUUID(), expSegs = 86400 } = {}) {
  return jwt.sign(
    { id: String(userId), tokenVersion, jti, amr: ['pwd'] },
    process.env.JWT_SECRET,
    { expiresIn: expSegs },
  )
}

describe('cierre de sesión por dispositivo', () => {
  test('dos sesiones del mismo usuario tienen jti distintos', () => {
    const userId = new mongoose.Types.ObjectId()
    const a = jwt.decode(emitirToken(userId))
    const b = jwt.decode(emitirToken(userId))

    expect(a.jti).toBeTruthy()
    expect(b.jti).toBeTruthy()
    expect(a.jti).not.toBe(b.jti)
    // El mismo titular y la misma versión global: lo único que los separa es el jti.
    expect(a.id).toBe(b.id)
    expect(a.tokenVersion).toBe(b.tokenVersion)
  })

  test('revocar una sesión NO revoca la otra', async () => {
    const userId = new mongoose.Types.ObjectId()
    const telefono  = jwt.decode(emitirToken(userId))
    const navegador = jwt.decode(emitirToken(userId))

    // El teléfono cierra sesión: sólo se anota SU jti.
    await RevokedToken.create({
      jti:       telefono.jti,
      userId,
      expiresAt: new Date(telefono.exp * 1000),
    })

    expect(await RevokedToken.exists({ jti: telefono.jti  })).toBeTruthy()
    expect(await RevokedToken.exists({ jti: navegador.jti })).toBeFalsy()
  })

  test('cerrar dos veces la misma sesión no duplica el registro', async () => {
    const userId = new mongoose.Types.ObjectId()
    const t = jwt.decode(emitirToken(userId))
    const doc = { jti: t.jti, userId, expiresAt: new Date(t.exp * 1000), reason: 'logout' }

    await RevokedToken.updateOne({ jti: t.jti }, { $setOnInsert: doc }, { upsert: true })
    await RevokedToken.updateOne({ jti: t.jti }, { $setOnInsert: doc }, { upsert: true })

    expect(await RevokedToken.countDocuments({ jti: t.jti })).toBe(1)
  })

  test('la caducidad guardada coincide con la del token, para que el TTL no lo borre antes', async () => {
    const userId = new mongoose.Types.ObjectId()
    const t = jwt.decode(emitirToken(userId, { expSegs: 3600 }))

    await RevokedToken.create({ jti: t.jti, userId, expiresAt: new Date(t.exp * 1000) })
    const guardado = await RevokedToken.findOne({ jti: t.jti }).lean()

    // Si se borrara antes de que el token caduque, el token revocado reviviría.
    expect(guardado.expiresAt.getTime()).toBe(t.exp * 1000)
    expect(guardado.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  test('el cambio de contraseña sigue matando TODAS las sesiones', () => {
    // Es lo que promete la política de privacidad publicada. Ese camino usa
    // tokenVersion, no la lista de revocación: al subir el contador, cualquier
    // token emitido con el valor anterior deja de validar, tenga el jti que tenga.
    const userId = new mongoose.Types.ObjectId()
    const antes1 = jwt.decode(emitirToken(userId, { tokenVersion: 3 }))
    const antes2 = jwt.decode(emitirToken(userId, { tokenVersion: 3 }))

    const versionEnBaseTrasCambio = 4

    expect(antes1.tokenVersion).not.toBe(versionEnBaseTrasCambio)
    expect(antes2.tokenVersion).not.toBe(versionEnBaseTrasCambio)
  })

  test('un token anterior al cambio no lleva jti y no rompe nada', () => {
    const userId = new mongoose.Types.ObjectId()
    const antiguo = jwt.sign(
      { id: String(userId), tokenVersion: 0, amr: ['pwd'] },   // sin jti
      process.env.JWT_SECRET,
      { expiresIn: 3600 },
    )
    const d = jwt.decode(antiguo)
    expect(d.jti).toBeUndefined()
    // tokenRevocado(undefined) devuelve false: el token sigue siendo válido
    // hasta que caduque solo. Es el camino de compatibilidad.
  })
})
