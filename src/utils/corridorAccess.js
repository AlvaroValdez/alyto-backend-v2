/**
 * corridorAccess.js — ¿Puede este consumidor operar por este corredor?
 *
 * El control comparaba ÚNICAMENTE el país de origen del corredor contra el país que
 * corresponde a la entidad del consumidor. Como la plataforma tiene corredores de
 * origen Bolivia bajo entidades distintas de la sociedad boliviana, un consumidor de
 * la S.R.L. superaba el control sobre un corredor de otra entidad: ambos son `BO`.
 *
 * El listado de corredores sí filtra por entidad, de modo que la ruta no era
 * alcanzable desde la interfaz. Pero una llamada con el identificador de corredor
 * explícito la alcanzaba, y la operación quedaba registrada con la entidad del
 * corredor — de modo que **no computaba contra los límites del Entorno Controlado**,
 * que se agregan por entidad `SRL`.
 *
 * Eso convertía la afirmación del apartado 9.7 del Informe Técnico —que los límites
 * operan como control técnico automático— en cierta salvo por una ruta. El Art. 13°
 * inc. f sanciona el exceso de límites con el rechazo del servicio, así que una ruta
 * que no computa es una brecha en el argumento central del capítulo 9.
 *
 * La decisión vive acá, en una función pura, porque el control estaba duplicado en dos
 * puntos —cotización y creación— con el mismo criterio escrito dos veces. Dos copias
 * de una regla divergen; una sola, no.
 */

/** País de origen que corresponde a cada entidad del grupo. */
export const ENTITY_ORIGIN_COUNTRY = Object.freeze({
  SpA: 'CL',
  SRL: 'BO',
  LLC: 'US',
});

/**
 * Evalúa el acceso de un consumidor a un corredor.
 *
 * @param {object} p
 * @param {{originCountry?:string, legalEntity?:string, corridorId?:string}} p.corridor
 * @param {{legalEntity?:string, residenceCountry?:string}} p.user
 * @returns {{allowed:boolean, reason:string|null, userOriginCountry:string,
 *            corridorOriginCountry:string|undefined}}
 */
export function evaluateCorridorAccess({ corridor, user }) {
  const userEntity        = user?.legalEntity;
  const userOriginCountry = ENTITY_ORIGIN_COUNTRY[userEntity] ?? user?.residenceCountry ?? 'CL';
  const base = { userOriginCountry, corridorOriginCountry: corridor?.originCountry };

  if (!corridor) {
    return { allowed: false, reason: 'CORRIDOR_NOT_FOUND', ...base };
  }

  // 1. País de origen — el control que ya existía.
  if (corridor.originCountry !== userOriginCountry) {
    return { allowed: false, reason: 'ORIGIN_COUNTRY_MISMATCH', ...base };
  }

  // 2. Entidad — el control que faltaba.
  //
  // Un corredor sin entidad declarada es un remanente anterior a la separación
  // societaria. Se admite ÚNICAMENTE para SpA, que es el mismo criterio con que el
  // listado de corredores los expone (`legalEntity: { $exists: false }` en la rama
  // SpA). Cualquier otra entidad exige coincidencia explícita: para la sociedad
  // boliviana, que es la del Entorno Controlado, no hay excepción por remanente.
  if (!corridor.legalEntity) {
    if (userEntity === 'SpA') return { allowed: true, reason: null, ...base };
    return { allowed: false, reason: 'CORRIDOR_WITHOUT_ENTITY', ...base };
  }

  if (corridor.legalEntity !== userEntity) {
    return { allowed: false, reason: 'ENTITY_MISMATCH', ...base };
  }

  return { allowed: true, reason: null, ...base };
}

/**
 * Cuerpo de la respuesta 403. No revela a qué entidad pertenece el corredor: al
 * consumidor no le aporta, y a quien sondea sí.
 */
export function corridorAccessDenialBody(evaluation) {
  return {
    error:                 'No tienes acceso a este corredor.',
    code:                  evaluation.reason,
    userOriginCountry:     evaluation.userOriginCountry,
    corridorOriginCountry: evaluation.corridorOriginCountry,
  };
}

export default { ENTITY_ORIGIN_COUNTRY, evaluateCorridorAccess, corridorAccessDenialBody };
