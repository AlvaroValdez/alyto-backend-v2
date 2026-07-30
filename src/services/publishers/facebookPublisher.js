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

/**
 * Publica una pieza como post de texto en la página.
 *
 * El cuerpo se envía tal cual, con el título como primera línea: Facebook no
 * tiene campo de título separado, así que la pieza se lee como un solo post.
 *
 * @param {{titulo:string, cuerpo:string}} pieza
 * @returns {Promise<{postId:string, url:string|null, raw:object}>}
 * @throws {Error & {code:string, status?:number}}
 */
export async function publicar({ titulo, cuerpo }) {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token  = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

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
