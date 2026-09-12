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

// ─────────────────────────────────────────────────────────────────────────────
describe('salud de la credencial', () => {
  // Un token "permanente" (expires_at 0) igual muere con un cambio de contraseña
  // o un evento de seguridad de Meta. Pasó de verdad: la consolidación de cuentas
  // invalidó el token y nos enteramos recién al intentar publicar.

  let verificarCredencial, __resetCacheVerificacion
  beforeAll(async () => {
    const fb = await import('../../src/services/publishers/facebookPublisher.js')
    verificarCredencial = fb.verificarCredencial
    __resetCacheVerificacion = fb.__resetCacheVerificacion
  })
  beforeEach(() => __resetCacheVerificacion())

  test('token vivo → ok:true, sin vencimiento, con permisos', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({
      data: { is_valid: true, expires_at: 0, type: 'PAGE',
              scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'] },
    })})

    const v = await verificarCredencial()

    expect(v.ok).toBe(true)
    expect(v.expira).toBeNull()                       // null = no expira
    expect(v.permisos).toContain('pages_manage_posts')
  })

  test('token invalidado (código 190) → ok:false con el motivo de Meta', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({
      error: { code: 190, message: 'The session has been invalidated because the user changed their password' },
    })})

    const v = await verificarCredencial()

    expect(v.ok).toBe(false)
    expect(v.codigo).toBe(190)
    expect(v.motivo).toMatch(/invalidated/i)
  })

  test('sin credencial configurada → ok:false diciendo QUÉ falta', async () => {
    delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN

    const v = await verificarCredencial()

    expect(v.ok).toBe(false)
    expect(v.motivo).toContain('FACEBOOK_PAGE_ACCESS_TOKEN')
    expect(fetchMock).not.toHaveBeenCalled()          // ni se molesta en llamar
  })

  test('timeout de red → ok:null (indeterminado), NO false', async () => {
    // Distinción deliberada: afirmar que la credencial murió cuando solo se cayó
    // la red haría que alguien la regenere sin necesidad.
    fetchMock.mockRejectedValue(new Error('The operation was aborted due to timeout'))

    const v = await verificarCredencial()

    expect(v.ok).toBeNull()
    expect(v.motivo).toMatch(/no se pudo verificar/i)
  })

  test('cachea el resultado: dos llamadas seguidas pegan una sola vez a Meta', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({
      data: { is_valid: true, expires_at: 0, scopes: [] },
    })})

    await verificarCredencial()
    await verificarCredencial()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Carruseles — dos fases, dos semánticas de fallo
//
// Publicar un carrusel no es un pedido sino dos: subir cada imagen (invisible) y
// recién después crear el post. Lo que se fija acá es que fallar en la primera
// fase NO trabe la pieza —nada salió al aire— y que fallar sin respuesta en la
// segunda SÍ la trabe, igual que un post de texto.
// ─────────────────────────────────────────────────────────────────────────────

const SLIDES = [
  { orden: 1, rol: 'portada',    titulo: 'Cinco señales', texto: '' },
  { orden: 2, rol: 'desarrollo', titulo: 'Te apuran',     texto: 'La urgencia es señal de alerta.' },
  { orden: 3, rol: 'cierre',     titulo: 'Ante la duda',  texto: 'Consultá antes de mover tu dinero.' },
]

const sembrarCarrusel = (over = {}) => sembrar({ formato: 'carrusel', slides: SLIDES, ...over })

/**
 * Mockea las tres clases de llamada de un carrusel: subir foto (POST /photos),
 * crear el post (POST /feed) y pedir el permalink (GET).
 */
function mockCarrusel({ subir = null, feed = null } = {}) {
  const n = { subidas: 0, posts: 0, borrados: 0 }
  fetchMock.mockImplementation(async (url, opts) => {
    const u = String(url)
    if (opts?.method === 'DELETE') { n.borrados++; return { ok: true, status: 200, json: async () => ({ success: true }) } }
    if (opts?.method === 'POST' && u.includes('/photos')) {
      n.subidas++
      return subir ? subir(n.subidas) : { ok: true, status: 200, json: async () => ({ id: `media_${n.subidas}` }) }
    }
    if (opts?.method === 'POST' && u.includes('/feed')) {
      n.posts++
      return feed ? feed() : okMeta('999_carrusel')
    }
    return { ok: true, status: 200, json: async () => ({ permalink_url: 'https://fb.com/p/1' }) }
  })
  return n
}

describe('carrusel — camino feliz', () => {
  test('sube una imagen por slide y después crea el post', async () => {
    const pieza = await sembrarCarrusel()
    const n = mockCarrusel()

    const r = await publicarPieza(pieza._id.toString(), { actor: 'admin@alyto.app' })

    expect(n.subidas).toBe(3)
    expect(n.posts).toBe(1)
    expect(r.estado).toBe('publicado')
    expect(r.publicacion.postId).toBe('999_carrusel')
  })

  test('adjunta los media_fbid en orden', async () => {
    const pieza = await sembrarCarrusel()
    mockCarrusel()

    await publicarPieza(pieza._id.toString(), { actor: 'a' })

    const feed = fetchMock.mock.calls.find(([u, o]) => o?.method === 'POST' && String(u).includes('/feed'))
    const enviado = feed[1].body.toString()
    expect(enviado).toContain('attached_media%5B0%5D')
    expect(decodeURIComponent(enviado)).toContain('{"media_fbid":"media_1"}')
    expect(decodeURIComponent(enviado)).toContain('{"media_fbid":"media_3"}')
  })

  test('las imágenes se suben como no publicadas', async () => {
    const pieza = await sembrarCarrusel()
    mockCarrusel()
    await publicarPieza(pieza._id.toString(), { actor: 'a' })

    const subida = fetchMock.mock.calls.find(([u, o]) => o?.method === 'POST' && String(u).includes('/photos'))
    expect(subida[1].body.get('published')).toBe('false')
  })
})

describe('carrusel — fallar subiendo NO traba la pieza', () => {
  test('si una imagen es rechazada, la pieza queda libre para reintentar', async () => {
    const pieza = await sembrarCarrusel()
    const n = mockCarrusel({ subir: (i) => (i === 2 ? errorMeta('Image too large', 400, 1) : okMeta(`media_${i}`)) })

    await expect(publicarPieza(pieza._id.toString(), { actor: 'a' }))
      .rejects.toMatchObject({ code: 'SUBIDA_FALLIDA' })

    const tras = await ContentPiece.findById(pieza._id).lean()
    expect(tras.publicacion.enCurso).toBe(false)   // nada salió al aire
    expect(tras.publicacion.postId).toBeNull()
    expect(n.posts).toBe(0)
  })

  test('borra las imágenes que ya había subido', async () => {
    const pieza = await sembrarCarrusel()
    const n = mockCarrusel({ subir: (i) => (i === 3 ? errorMeta('boom', 400, 1) : okMeta(`media_${i}`)) })

    await expect(publicarPieza(pieza._id.toString(), { actor: 'a' })).rejects.toThrow()

    expect(n.borrados).toBe(2)   // las dos que sí subieron
  })

  test('un timeout subiendo tampoco traba: el post no existe', async () => {
    const pieza = await sembrarCarrusel()
    mockCarrusel({ subir: () => { throw new Error('fetch failed') } })

    await expect(publicarPieza(pieza._id.toString(), { actor: 'a' }))
      .rejects.toMatchObject({ code: 'SUBIDA_FALLIDA' })

    expect((await ContentPiece.findById(pieza._id).lean()).publicacion.enCurso).toBe(false)
  })
})

describe('carrusel — fallar creando el post SÍ traba', () => {
  test('sin respuesta al crear el post → pieza trabada', async () => {
    const pieza = await sembrarCarrusel()
    mockCarrusel({ feed: () => { throw new Error('socket hang up') } })

    await expect(publicarPieza(pieza._id.toString(), { actor: 'a' }))
      .rejects.toMatchObject({ code: 'PUBLICADOR_SIN_RESPUESTA' })

    const tras = await ContentPiece.findById(pieza._id).lean()
    expect(tras.publicacion.enCurso).toBe(true)   // no sabemos si salió
  })

  test('no borra las imágenes si no sabe si el post salió', async () => {
    // Borrarlas destrozaría un carrusel que sí se publicó.
    const pieza = await sembrarCarrusel()
    const n = mockCarrusel({ feed: () => { throw new Error('socket hang up') } })

    await expect(publicarPieza(pieza._id.toString(), { actor: 'a' })).rejects.toThrow()

    expect(n.borrados).toBe(0)
  })

  test('rechazo explícito de Meta → no traba y limpia', async () => {
    const pieza = await sembrarCarrusel()
    const n = mockCarrusel({ feed: () => errorMeta('Invalid attachment', 400, 100) })

    await expect(publicarPieza(pieza._id.toString(), { actor: 'a' }))
      .rejects.toMatchObject({ code: 'PUBLICADOR_RECHAZO' })

    expect((await ContentPiece.findById(pieza._id).lean()).publicacion.enCurso).toBe(false)
    expect(n.borrados).toBe(3)
  })
})

describe('carrusel — el render falla antes de tocar nada', () => {
  test('un titular que no entra da 422 sin consumir intento ni trabar', async () => {
    const pieza = await sembrarCarrusel({
      slides: [
        { orden: 1, rol: 'portada',    titulo: 'Una portada con un titular tan largo que no entra jamás en tres líneas de noventa y seis píxeles', texto: '' },
        { orden: 2, rol: 'cierre',     titulo: 'Ante la duda', texto: 'Consultá.' },
      ],
    })
    const n = mockCarrusel()

    await expect(publicarPieza(pieza._id.toString(), { actor: 'a' }))
      .rejects.toMatchObject({ code: 'RENDER_FALLIDO' })

    const tras = await ContentPiece.findById(pieza._id).lean()
    expect(tras.publicacion.enCurso).toBe(false)
    expect(tras.publicacion.intentos).toBe(0)   // ni siquiera se reclamó
    expect(n.subidas).toBe(0)
  })
})

describe('un post de texto sigue publicándose igual', () => {
  test('no sube imágenes ni cambia de camino', async () => {
    const pieza = await sembrar()   // formato 'post' por defecto
    const n = mockCarrusel()

    const r = await publicarPieza(pieza._id.toString(), { actor: 'a' })

    expect(n.subidas).toBe(0)
    expect(n.posts).toBe(1)
    expect(r.estado).toBe('publicado')
  })
})
