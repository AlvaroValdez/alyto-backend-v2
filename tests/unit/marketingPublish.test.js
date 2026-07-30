/**
 * marketingPublish.test.js — Publicación de piezas a redes sociales.
 *
 * Publicar es la única acción del módulo que sale del sistema y no se deshace
 * desde acá. Los tests se concentran en eso:
 *
 *   1. Que NO se publique dos veces, ni siquiera con dos clics simultáneos.
 *   2. Que un fallo de red deje la pieza TRABADA (no sabemos si el post salió)
 *      y que un rechazo explícito de la red NO la trabe (sabemos que no salió).
 *   3. Que las prohibiciones se revisen otra vez justo antes de publicar.
 *   4. Que TikTok se rechace con una explicación, no con un error opaco.
 *
 * El adaptador de Facebook se mockea a nivel de `fetch`: así se ejercita el
 * adaptador real (armado del payload, lectura de la respuesta de Meta) sin salir
 * a internet.
 */

import '../setup.env.js'
import { jest } from '@jest/globals'

await jest.unstable_mockModule('@sentry/node', () => ({ captureException: jest.fn() }))

const { connectTestDb, disconnectTestDb, clearCollections } = await import('../helpers/db.js')
const { publicarPieza, destrabarPieza, isPublishEnabled } =
  await import('../../src/services/marketingPublishService.js')
const { default: ContentPiece } = await import('../../src/models/ContentPiece.js')

const fetchMock = jest.fn()
global.fetch = fetchMock

const okMeta = (id = '123_456') => ({
  ok: true, status: 200, json: async () => ({ id }),
})

// El adaptador hace DOS llamadas: POST /feed para publicar y GET ?permalink_url
// para el enlace. `mockPublicacion` las distingue y cuenta solo las de publicar,
// que son las que no deben repetirse nunca.
function mockPublicacion({ id = '123_456', permalink = 'https://www.facebook.com/x/posts/y',
                           publicar = null, demora = 0 } = {}) {
  const contador = { publicaciones: 0, permalinks: 0 }
  fetchMock.mockImplementation(async (url, opts) => {
    if (opts?.method === 'POST') {
      contador.publicaciones++
      if (demora) await new Promise(r => setTimeout(r, demora))
      return publicar ? publicar() : okMeta(id)
    }
    contador.permalinks++
    return { ok: true, status: 200, json: async () => ({ id, permalink_url: permalink }) }
  })
  return contador
}
const errorMeta = (msg = 'Invalid OAuth access token', status = 400, code = 190) => ({
  ok: false, status, json: async () => ({ error: { message: msg, code } }),
})

const sembrar = (over = {}) => ContentPiece.create({
  titulo: 'La custodia institucional',
  cuerpo: 'Una entidad regulada protege tus activos digitales.',
  canal: 'facebook', tipo: 'educacion',
  autoevaluacionRiesgo: 'bajo', clasificacionFinal: 'bajo',
  estado: 'autopublicado', ...over,
})

beforeAll(async () => { await connectTestDb() })
afterAll(async () => { await disconnectTestDb() })
afterEach(async () => { await clearCollections(); fetchMock.mockReset() })

beforeEach(() => {
  process.env.MARKETING_PUBLISH_ENABLED = 'true'
  process.env.FACEBOOK_PAGE_ID = '999'
  process.env.FACEBOOK_PAGE_ACCESS_TOKEN = 'test-token'
})

// ─────────────────────────────────────────────────────────────────────────────
describe('gating', () => {
  test('con MARKETING_PUBLISH_ENABLED apagado no se llama a la red', async () => {
    process.env.MARKETING_PUBLISH_ENABLED = 'false'
    expect(isPublishEnabled()).toBe(false)
    const p = await sembrar()

    await expect(publicarPieza(p._id.toString()))
      .rejects.toMatchObject({ code: 'PUBLICACION_DESHABILITADA' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('sin credenciales de Facebook se explica QUÉ falta', async () => {
    delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN
    const p = await sembrar()

    await expect(publicarPieza(p._id.toString()))
      .rejects.toMatchObject({ code: 'PUBLICADOR_NO_CONFIGURADO', falta: ['FACEBOOK_PAGE_ACCESS_TOKEN'] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('camino feliz', () => {
  test('publica, guarda postId y pasa a estado publicado', async () => {
    mockPublicacion({ id: '999_888', permalink: 'https://www.facebook.com/abc/posts/888' })
    const p = await sembrar()

    const out = await publicarPieza(p._id.toString(), { actor: 'admin@alyto.app' })

    expect(out.estado).toBe('publicado')
    expect(out.publicacion.postId).toBe('999_888')
    // El permalink lo devuelve Meta; NO se construye con el id de la página.
    expect(out.publicacion.url).toBe('https://www.facebook.com/abc/posts/888')
    expect(out.publicacion.publicadoPor).toBe('admin@alyto.app')
    expect(out.publicacion.enCurso).toBe(false)
    expect(out.publicacion.intentos).toBe(1)
  })

  test('el post lleva título y cuerpo en un solo mensaje', async () => {
    mockPublicacion()
    const p = await sembrar({ titulo: 'Título', cuerpo: 'Cuerpo del post.' })

    await publicarPieza(p._id.toString())

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.message).toBe('Título\n\nCuerpo del post.')
    expect(fetchMock.mock.calls[0][0]).toContain('/999/feed')
  })

  test('si el permalink falla, la publicación NO falla: se guarda el postId igual', async () => {
    // El permalink es cosmético; el postId es el registro. Dejar que un fallo
    // cosmético convierta una publicación exitosa en error haría que el sistema
    // pierda el rastro de un post que sí salió.
    fetchMock.mockImplementation(async (url, opts) => {
      if (opts?.method === 'POST') return okMeta('555_666')
      throw new Error('ETIMEDOUT')          // falla solo el GET del permalink
    })
    const p = await sembrar()

    const out = await publicarPieza(p._id.toString())

    expect(out.estado).toBe('publicado')
    expect(out.publicacion.postId).toBe('555_666')
    expect(out.publicacion.url).toBeNull()
  })

  test('una pieza aprobada por un humano también se publica', async () => {
    mockPublicacion()
    const p = await sembrar({ estado: 'aprobado', clasificacionFinal: 'alto', aprobadoPor: 'admin@alyto.app' })

    expect((await publicarPieza(p._id.toString())).estado).toBe('publicado')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('idempotencia: nunca dos veces', () => {
  test('publicar una pieza ya publicada devuelve YA_PUBLICADA sin llamar a la red', async () => {
    mockPublicacion({ id: '111_222' })
    const p = await sembrar()
    await publicarPieza(p._id.toString())
    fetchMock.mockClear()

    await expect(publicarPieza(p._id.toString()))
      .rejects.toMatchObject({ code: 'YA_PUBLICADA', postId: '111_222' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('dos clics simultáneos → un solo post', async () => {
    const contador = mockPublicacion({ id: '777_888', demora: 30 })  // ventana para la carrera
    const p = await sembrar()
    const id = p._id.toString()

    const res = await Promise.allSettled([publicarPieza(id), publicarPieza(id)])

    expect(contador.publicaciones).toBe(1)                     // se publicó UNA vez
    expect(res.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(res.find(r => r.status === 'rejected').reason.code).toBe('INTENTO_EN_CURSO')

    const final = await ContentPiece.findById(id).lean()
    expect(final.publicacion.postId).toBe('777_888')
  })

  test.each([
    ['pendiente_aprobacion'],
    ['rechazado'],
  ])('una pieza en estado %s no se publica', async (estado) => {
    const p = await sembrar({ estado, clasificacionFinal: 'alto' })

    await expect(publicarPieza(p._id.toString()))
      .rejects.toMatchObject({ code: 'ESTADO_NO_PUBLICABLE', estado })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('fallos: la diferencia entre "no salió" y "no sé"', () => {
  test('rechazo explícito de la red → NO queda trabada (sabemos que no salió)', async () => {
    fetchMock.mockResolvedValue(errorMeta('Invalid OAuth access token'))
    const p = await sembrar()

    await expect(publicarPieza(p._id.toString()))
      .rejects.toMatchObject({ code: 'PUBLICADOR_RECHAZO' })

    const tras = await ContentPiece.findById(p._id).lean()
    expect(tras.publicacion.enCurso).toBe(false)        // se puede reintentar
    expect(tras.publicacion.postId).toBeNull()
    expect(tras.publicacion.ultimoError).toContain('OAuth')
    expect(tras.estado).toBe('autopublicado')           // no se movió
  })

  test('fallo de red → SÍ queda trabada (no sabemos si el post salió)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    const p = await sembrar()

    await expect(publicarPieza(p._id.toString()))
      .rejects.toMatchObject({ code: 'PUBLICADOR_SIN_RESPUESTA' })

    const tras = await ContentPiece.findById(p._id).lean()
    expect(tras.publicacion.enCurso).toBe(true)         // bloqueada a propósito
    expect(tras.publicacion.postId).toBeNull()
  })

  test('una pieza trabada NO se reintenta sola', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    const p = await sembrar()
    await publicarPieza(p._id.toString()).catch(() => {})
    fetchMock.mockClear()

    await expect(publicarPieza(p._id.toString()))
      .rejects.toMatchObject({ code: 'INTENTO_EN_CURSO' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('destrabar exige criterio humano y permite reintentar', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    const p = await sembrar()
    await publicarPieza(p._id.toString()).catch(() => {})

    await destrabarPieza(p._id.toString(), { actor: 'admin@alyto.app' })

    fetchMock.mockReset()
    mockPublicacion({ id: '333_444' })
    const out = await publicarPieza(p._id.toString())

    expect(out.publicacion.postId).toBe('333_444')
    expect(out.publicacion.intentos).toBe(2)   // el intento fallido quedó contado
  })

  test('no se puede destrabar una pieza que ya se publicó', async () => {
    mockPublicacion()
    const p = await sembrar()
    await publicarPieza(p._id.toString())

    await expect(destrabarPieza(p._id.toString()))
      .rejects.toMatchObject({ code: 'YA_PUBLICADA' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('último control antes de salir al aire', () => {
  test('una prohibición absoluta bloquea la publicación aunque la pieza esté aprobada', async () => {
    // Escenario real: se aprobó hace días, o entró como autopublicado sin que
    // nadie la leyera. Este es el último momento en que revisar sale gratis.
    const p = await sembrar({
      estado: 'aprobado',
      cuerpo: 'Tus fondos están asegurados por FDIC.',
    })

    await expect(publicarPieza(p._id.toString()))
      .rejects.toMatchObject({ code: 'CONTENIDO_PROHIBIDO' })
    expect(fetchMock).not.toHaveBeenCalled()

    const tras = await ContentPiece.findById(p._id).lean()
    expect(tras.publicacion.postId).toBeNull()
    expect(tras.publicacion.intentos).toBe(0)   // ni siquiera se reclamó
  })

  test('la sugerencia visual también se revisa', async () => {
    const p = await sembrar({
      sugerenciaVisual: 'Cartel que dice "somos regulados por ASFI".',
    })

    await expect(publicarPieza(p._id.toString()))
      .rejects.toMatchObject({ code: 'CONTENIDO_PROHIBIDO' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('canales sin publicador', () => {
  test('TikTok se rechaza explicando por qué, no con un error opaco', async () => {
    const p = await sembrar({ canal: 'tiktok' })

    const err = await publicarPieza(p._id.toString()).catch(e => e)

    expect(err.code).toBe('CANAL_SIN_PUBLICADOR')
    expect(err.canal).toBe('tiktok')
    expect(err.message).toMatch(/video|im[áa]genes/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('X todavía no tiene adaptador y se informa igual', async () => {
    const p = await sembrar({ canal: 'x' })
    await expect(publicarPieza(p._id.toString()))
      .rejects.toMatchObject({ code: 'CANAL_SIN_PUBLICADOR', canal: 'x' })
  })
})
