// src/services/publishers/publisherRegistry.js
//
// Registro de publicadores por canal. Mismo patrón que providerRegistry.js del
// lado de pagos: agregar una red nueva = un archivo adaptador + una línea acá.
//
// Vive en services/ y no en providers/ a propósito: providers/ es el namespace
// del enrutamiento financiero (payin, payout, transit), y una red social no
// tiene nada que ver con mover dinero. Mezclarlos confundiría el mapa.
//
// Contrato de un adaptador:
//   canal            string — coincide con ContentPiece.canal
//   nombre           string — para mensajes al admin
//   disponible()     boolean — ¿está configurado?
//   faltaConfigurar() string[] — qué env vars faltan
//   publicar(pieza)  → { postId, url }  · lanza con .code en caso de error
//
// ⚠️ TikTok NO tiene adaptador, y no es un olvido: su Content Posting API exige
// video o carrusel de fotos y no acepta posts de solo texto. Mientras el agente
// genere texto, una pieza de TikTok no se puede publicar por API. El registro
// devuelve null y el servicio lo explica en vez de fallar de forma opaca.

import * as facebook from './facebookPublisher.js';

const PUBLICADORES = {
  [facebook.canal]: facebook,
};

/** Canales que tienen adaptador (configurado o no). */
export function canalesSoportados() {
  return Object.keys(PUBLICADORES);
}

/**
 * Devuelve el publicador de un canal, o null si esa red no se puede publicar
 * por API con el contenido que genera el agente.
 */
export function getPublisher(canal) {
  return PUBLICADORES[canal] ?? null;
}

/** Estado de cada canal, para que el panel muestre qué se puede publicar. */
export function estadoPublicadores() {
  return Object.values(PUBLICADORES).map(p => ({
    canal:     p.canal,
    nombre:    p.nombre,
    disponible: p.disponible(),
    falta:     p.disponible() ? [] : p.faltaConfigurar(),
  }));
}

/**
 * Estado + verificación real de la credencial de cada canal.
 *
 * Se separa de estadoPublicadores() porque esta versión hace I/O contra la red:
 * quien solo necesita saber si un canal está configurado no debería pagar una
 * llamada a Meta. Las verificaciones corren en paralelo y ninguna puede tumbar
 * a las otras.
 */
export async function verificarCanales() {
  const publicadores = Object.values(PUBLICADORES);
  const verificaciones = await Promise.all(publicadores.map(async p => {
    if (typeof p.verificarCredencial !== 'function') return { ok: null, motivo: 'Sin verificación implementada.' };
    try { return await p.verificarCredencial(); }
    catch (err) { return { ok: null, motivo: `Verificación falló: ${err.message}` }; }
  }));
  return publicadores.map((p, i) => ({
    canal: p.canal,
    nombre: p.nombre,
    disponible: p.disponible(),
    falta: p.disponible() ? [] : p.faltaConfigurar(),
    credencial: verificaciones[i],
  }));
}

export default { canalesSoportados, getPublisher, estadoPublicadores, verificarCanales };
