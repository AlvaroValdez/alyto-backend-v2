// src/services/publishers/facebookPublisher.js
//
// Publicador de Facebook — Meta Graph API, endpoint /{page-id}/feed.
//
// Publica en una PÁGINA, nunca en un perfil personal (la API no lo permite y
// tampoco sería lo que queremos).
//
// Requisitos del lado de Meta, que NO se resuelven desde el código:
//   - Permisos pages_manage_posts + pages_read_engagement + pages_show_list
//   - App Review aprobado por Meta (semanas) + verificación de negocio
//   - Un Page Access Token de larga duración
//
// Configuración:
//   FACEBOOK_PAGE_ID            id numérico de la página
//   FACEBOOK_PAGE_ACCESS_TOKEN  token de página (largo plazo)
//   FACEBOOK_GRAPH_VERSION      opcional, default v21.0
//
// Si falta cualquiera de las dos primeras, `disponible()` devuelve false y el
// servicio responde con un error claro en vez de intentar y fallar con un 400
// incomprensible de Meta.

const GRAPH = () => `https://graph.facebook.com/${process.env.FACEBOOK_GRAPH_VERSION || 'v21.0'}`;

export const canal = 'facebook';
export const nombre = 'Facebook';

/** ¿Está configurado este publicador? */
export function disponible() {
  return Boolean(process.env.FACEBOOK_PAGE_ID && process.env.FACEBOOK_PAGE_ACCESS_TOKEN);
}

/** Qué falta configurar, para poder decírselo al admin sin que revise logs. */
export function faltaConfigurar() {
  const faltan = [];
  if (!process.env.FACEBOOK_PAGE_ID) faltan.push('FACEBOOK_PAGE_ID');
  if (!process.env.FACEBOOK_PAGE_ACCESS_TOKEN) faltan.push('FACEBOOK_PAGE_ACCESS_TOKEN');
  return faltan;
}

// ─────────────────────────────────────────────────────────────────────────────
// Salud de la credencial
//
// Un Page Access Token "permanente" (expires_at = 0) NO es inmortal: muere con
// un cambio de contraseña, con un evento de seguridad de Meta (la consolidación
// de cuentas invalidó sesiones y nos pasó), al perder el rol de admin sobre la
// Página o al borrar la app.
//
// Sin este chequeo el operador se entera de que el token murió recién cuando
// intenta publicar. Con él, el panel lo muestra antes de que alguien redacte una
// pieza contando con poder publicarla.
//
// NUNCA lanza: un fallo de la verificación no puede romper la pantalla de estado.
// ─────────────────────────────────────────────────────────────────────────────

const TTL_VERIFICACION_MS = 60_000;   // el panel se refresca seguido; no castigar a Meta
let cacheVerificacion = null;         // { vencimiento, resultado }

/**
 * ¿La credencial sirve ahora mismo?
 *
 * `ok` es de tres estados a propósito:
 *   true  → verificada y válida
 *   false → Meta dice que no sirve
 *   null  → no se pudo verificar (timeout/red). NO es lo mismo que "rota":
 *           afirmar que murió haría que alguien la regenere sin necesidad.
 *
 * @returns {Promise<{ok:boolean|null, motivo?:string, codigo?:number, expira?:string|null, permisos?:string[]}>}
 */
export async function verificarCredencial() {
  if (!disponible()) {
    return { ok: false, motivo: `Sin configurar: falta ${faltaConfigurar().join(', ')}.` };
  }

  if (cacheVerificacion && Date.now() < cacheVerificacion.vencimiento) {
    return cacheVerificacion.resultado;
  }

  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  let resultado;

  try {
    const r = await fetch(
      `${GRAPH()}/debug_token?input_token=${encodeURIComponent(token)}` +
      `&access_token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(5000) },   // /estado no puede colgarse por Meta
    );
    const d = await r.json();

    if (d.error) {
      // El 190 es el caso real: invalidado por cambio de contraseña o evento de
      // seguridad. Meta explica cuál en el mensaje, así que se pasa tal cual.
      resultado = { ok: false, motivo: d.error.message, codigo: d.error.code ?? null };
    } else if (!d.data?.is_valid) {
      resultado = { ok: false, motivo: 'Meta reporta la credencial como no válida.' };
    } else {
      resultado = {
        ok: true,
        expira: d.data.expires_at === 0 ? null : new Date(d.data.expires_at * 1000).toISOString(),
        permisos: d.data.scopes ?? [],
      };
    }
  } catch (err) {
    resultado = { ok: null, motivo: `No se pudo verificar con Meta: ${err.message}` };
  }

  cacheVerificacion = { vencimiento: Date.now() + TTL_VERIFICACION_MS, resultado };
  return resultado;
}

/** Solo para tests: invalida el cache de la verificación. */
export function __resetCacheVerificacion() {
  cacheVerificacion = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Carrusel (post multi-foto)
//
// Meta no tiene "publicar carrusel" en un solo pedido. Son dos fases:
//
//   1. Subir cada imagen a /{page-id}/photos con published=false → media_fbid.
//      Las fotos quedan en la página pero INVISIBLES.
//   2. Crear el post en /{page-id}/feed con attached_media[i]={media_fbid}.
//
// Esa forma decide la semántica de fallo, y es distinta de la del post de texto:
//
//   Falla en la fase 1 → NO hay post. Da igual si fue rechazo o timeout: nada
//     salió al aire, así que la pieza se puede destrabar sin riesgo. Lo peor que
//     queda son fotos invisibles huérfanas, que se intentan borrar.
//   Falla en la fase 2 sin respuesta → mismo caso que el post de texto: no
//     sabemos si salió, la pieza queda TRABADA para que un humano mire.
//
// Por eso los errores de subida llevan código propio (SUBIDA_FALLIDA): el
// servicio lo usa para decidir si traba o no. Colapsarlo con el genérico haría
// que cada timeout subiendo una foto exija destrabar a mano sin motivo.
// ─────────────────────────────────────────────────────────────────────────────

const TIMEOUT_SUBIDA_MS = 30_000;   // 200KB por slide; 30s es de sobra
const TIMEOUT_FEED_MS   = 20_000;

/**
 * Sube un PNG como foto no publicada y devuelve su media_fbid.
 * @throws {Error & {code:'SUBIDA_FALLIDA'}}
 */
async function subirFoto(png, nombre, { pageId, token }) {
  const form = new FormData();
  form.append('published', 'false');
  form.append('access_token', token);
  form.append('source', new Blob([png], { type: 'image/png' }), nombre);

  let resp;
  try {
    resp = await fetch(`${GRAPH()}/${pageId}/photos`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT_SUBIDA_MS),
    });
  } catch (err) {
    const e = new Error(`No se pudo subir ${nombre}: ${err.message}`);
    e.code = 'SUBIDA_FALLIDA';
    throw e;
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.id) {
    const e = new Error(`Meta rechazó la imagen ${nombre}: ${data?.error?.message || `HTTP ${resp.status}`}`);
    e.code = 'SUBIDA_FALLIDA';
    e.metaCode = data?.error?.code ?? null;
    throw e;
  }
  return data.id;
}

/**
 * Borra fotos subidas que nunca llegaron a publicarse.
 *
 * Best-effort y silencioso a propósito: son invisibles, así que no borrarlas no
 * rompe nada. Pero sin esto cada reintento fallido deja basura acumulada en la
 * página, y con los intentos suficientes eso sí se nota.
 */
async function borrarHuerfanas(ids, { token }) {
  await Promise.allSettled(ids.map(id =>
    fetch(`${GRAPH()}/${id}?access_token=${encodeURIComponent(token)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(10_000) }),
  ));
}

/**
 * Publica un carrusel: sube las imágenes y las adjunta a un post.
 *
 * @param {{titulo:string, cuerpo:string}} pieza
 * @param {Array<{orden:number, png:Buffer}>} imagenes  ya renderizadas, en orden
 */
async function publicarCarrusel({ titulo, cuerpo }, imagenes, { pageId, token }) {
  const message = [titulo, cuerpo].filter(Boolean).join('\n\n');

  // Fase 1 — en serie, no en paralelo: Meta limita la tasa de subida por página,
  // y 10 subidas simultáneas se ganan un 429 que aborta el carrusel entero.
  const mediaIds = [];
  try {
    for (const { orden, png } of imagenes) {
      mediaIds.push(await subirFoto(png, `slide-${orden}.png`, { pageId, token }));
    }
  } catch (err) {
    await borrarHuerfanas(mediaIds, { token });
    throw err;   // SUBIDA_FALLIDA — nada se publicó, la pieza no queda trabada
  }

  // Fase 2 — el post. attached_media va como campos indexados, no como JSON:
  // la Graph API no acepta un array anidado en un cuerpo JSON.
  const cuerpoForm = new URLSearchParams({ message, access_token: token });
  mediaIds.forEach((id, i) => cuerpoForm.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));

  let resp;
  try {
    resp = await fetch(`${GRAPH()}/${pageId}/feed`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    cuerpoForm,
      signal:  AbortSignal.timeout(TIMEOUT_FEED_MS),
    });
  } catch (err) {
    // No se limpian las huérfanas acá: si el post SÍ salió, borrarlas lo
    // destrozaría. La pieza queda trabada y lo resuelve un humano mirando.
    const e = new Error(`No se pudo contactar a Meta al crear el post: ${err.message}`);
    e.code = 'PUBLICADOR_SIN_RESPUESTA';
    throw e;
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.id) {
    await borrarHuerfanas(mediaIds, { token });
    const e = new Error(`Meta rechazó el carrusel: ${data?.error?.message || `HTTP ${resp.status}`}`);
    e.code   = 'PUBLICADOR_RECHAZO';
    e.status = resp.status;
    e.metaCode = data?.error?.code ?? null;
    throw e;
  }

  return { postId: data.id, url: await permalink(data.id, token), raw: data };
}

/**
 * Publica una pieza en la página.
 *
 * Un post de texto lleva el título como primera línea del mensaje: Facebook no
 * tiene campo de título separado, así que la pieza se lee como un solo post.
 * Un carrusel usa el mismo mensaje como pie y adjunta las imágenes.
 *
 * @param {{titulo:string, cuerpo:string}} pieza
 * @param {{imagenes?: Array<{orden:number, png:Buffer}>}} [opts]
 *   `imagenes` las renderiza quien llama (marketingPublishService): este
 *   adaptador habla con Meta y no sabe dibujar.
 * @returns {Promise<{postId:string, url:string|null, raw:object}>}
 * @throws {Error & {code:string, status?:number}}
 */
export async function publicar({ titulo, cuerpo }, opts = {}) {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token  = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

  if (opts.imagenes?.length) {
    return publicarCarrusel({ titulo, cuerpo }, opts.imagenes, { pageId, token });
  }

  const message = [titulo, cuerpo].filter(Boolean).join('\n\n');

  let resp;
  try {
    resp = await fetch(`${GRAPH()}/${pageId}/feed`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message, access_token: token }),
    });
  } catch (err) {
    // Fallo de red: no sabemos si Meta recibió el pedido. Se propaga tal cual
    // para que el servicio deje la pieza trabada en vez de reintentar.
    const e = new Error(`No se pudo contactar a Meta: ${err.message}`);
    e.code = 'PUBLICADOR_SIN_RESPUESTA';
    throw e;
  }

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const detalle = data?.error?.message || `HTTP ${resp.status}`;
    const e = new Error(`Meta rechazó la publicación: ${detalle}`);
    e.code   = 'PUBLICADOR_RECHAZO';
    e.status = resp.status;
    // El código de Meta ayuda a distinguir token vencido (190) de permisos (200).
    e.metaCode = data?.error?.code ?? null;
    throw e;
  }

  // Meta devuelve `id` con formato "{page-id}_{post-id}".
  const postId = data.id;
  if (!postId) {
    const e = new Error('Meta respondió OK pero sin id de post.');
    e.code = 'PUBLICADOR_RESPUESTA_RARA';
    throw e;
  }

  return {
    postId,
    url: await permalink(postId, token),
    raw: data,
  };
}

/**
 * Pide a Meta el permalink del post.
 *
 * No se construye a mano: el primer segmento de la URL que devuelve Meta NO es
 * el id de la página (se verificó contra un post real), así que armarla con
 * `{page-id}/posts/{post-id}` produce un enlace roto. Hay que preguntárselo.
 *
 * ⚠️ Es best-effort a propósito. Si esta llamada falla, el post YA está
 * publicado: devolver null y seguir es correcto, porque el registro que importa
 * es el postId. Dejar que un fallo cosmético convierta una publicación exitosa
 * en un error haría que el sistema pierda el rastro de un post que sí salió —
 * el peor resultado posible.
 */
async function permalink(postId, token) {
  try {
    const r = await fetch(
      `${GRAPH()}/${postId}?fields=permalink_url&access_token=${encodeURIComponent(token)}`,
    );
    const d = await r.json();
    return d?.permalink_url ?? null;
  } catch {
    return null;
  }
}

export default { canal, nombre, disponible, faltaConfigurar, publicar };
