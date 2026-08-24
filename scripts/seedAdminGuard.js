/**
 * seedAdminGuard.js — La decisión de `seedAdmin.js`, aislada para poder probarla.
 *
 * Vive fuera del script porque el script se ejecuta al importarse: no hay forma de
 * probar la guarda sin conectarse a una base y arriesgar el borrado que la guarda
 * justamente existe para impedir. Acá es una función pura y la prueba es trivial.
 *
 * Tres resultados posibles:
 *
 *   'create'  — no hay cuenta previa; el camino legítimo.
 *   'recreate' — hay cuenta sin privilegios y se pidió recrear de forma explícita.
 *   'refuse'  — todo lo demás.
 *
 * Una cuenta con rol de administración cae SIEMPRE en 'refuse'. Deliberadamente no
 * hay variable que lo habilite: si la hubiera, el riesgo seguiría existiendo y sólo
 * cambiaría de nombre.
 */

/**
 * @param {{role?:string}|null} existing  Cuenta hallada con ese correo, o null.
 * @param {boolean} recreateRequested     Si se pidió `SEED_ADMIN_RECREATE=1`.
 * @returns {{action:'create'|'recreate'|'refuse', reason:string|null}}
 */
export function decideSeedAction(existing, recreateRequested) {
  if (!existing) return { action: 'create', reason: null };

  if (existing.role === 'admin') {
    return { action: 'refuse', reason: 'ADMIN_ACCOUNT_EXISTS' };
  }

  if (!recreateRequested) {
    return { action: 'refuse', reason: 'ACCOUNT_EXISTS' };
  }

  return { action: 'recreate', reason: null };
}

export default { decideSeedAction };
