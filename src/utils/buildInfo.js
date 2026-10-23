/**
 * buildInfo.js — qué commit está corriendo este proceso.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * El 2026-10-22 hizo falta saber si staging había tomado un cambio y **no había
 * forma de averiguarlo**: `/api/health` devuelve `version: "2.0.0"`, que sale de
 * `package.json` y no se mueve nunca, y el cambio en cuestión (una compuerta de
 * correo) no era observable por HTTP. La única respuesta disponible era inferir
 * desde los tiempos de reinicio, que es exactamente lo que no se debe hacer.
 *
 * ── Por qué NO va en /api/health, que es público ─────────────────────────────
 *
 * El repo **es público** (`AlvaroValdez/alyto-backend-v2`). Un SHA en un endpoint
 * abierto no es un dato inocuo: apunta al código exacto que corre, y comparándolo
 * contra `main` cualquiera deduce **qué arreglos todavía NO están desplegados**.
 * Para una plataforma financiera que acaba de ser sondeada, eso es entregar el
 * mapa. El comentario de `/api/health` ya advertía de no dar pie al fingerprinting
 * y tenía razón.
 *
 * Por eso vive detrás del token interno (`GET /api/v1/internal/version`), que es
 * la superficie pensada para acceso de máquina y de operador.
 *
 * ── De dónde sale el SHA en cada entorno ─────────────────────────────────────
 *
 *   Render (staging) → `RENDER_GIT_COMMIT`, que Render inyecta solo. Cero config.
 *   VPS (producción) → `GIT_COMMIT`, que pasa `deploy-vps.sh` como build arg del
 *                      Dockerfile. La imagen no trae `.git`, así que no se puede
 *                      resolver en tiempo de ejecución.
 *
 * Si no hay ninguna, se informa `null` en vez de inventar un valor: "no sé" es un
 * dato correcto y "2.0.0" para todo era justamente el problema.
 */

/** Variables que puede inyectar cada plataforma, en orden de confianza. */
const FUENTES = ['GIT_COMMIT', 'RENDER_GIT_COMMIT', 'SOURCE_COMMIT', 'COMMIT_SHA'];

/**
 * SHA completo del commit desplegado, o null si el entorno no lo informa.
 * Se lee DENTRO de la función (regla 21): en el ámbito de módulo quedaría
 * congelado antes de que Secrets Manager pueble `process.env`.
 *
 * @returns {string|null}
 */
export function commitSha() {
  for (const k of FUENTES) {
    const v = String(process.env[k] ?? '').trim();
    // Un SHA de git es hex de 7 a 40 caracteres. Se valida para no propagar un
    // placeholder como 'unknown', '$GIT_COMMIT' sin expandir o una cadena vacía.
    if (/^[0-9a-f]{7,40}$/i.test(v)) return v.toLowerCase();
  }
  return null;
}

/** Forma corta, la que se compara a ojo contra `git log --oneline`. */
export function commitCorto() {
  const sha = commitSha();
  return sha ? sha.slice(0, 7) : null;
}

/**
 * Identidad del despliegue, para el endpoint interno.
 * @returns {{ commit: string|null, commitCorto: string|null, version: string, entorno: string, arrancado: string }}
 */
export function buildInfo() {
  return {
    commit:      commitSha(),
    commitCorto: commitCorto(),
    version:     process.env.npm_package_version ?? '2.0.0',
    // Útil justamente para distinguir staging de producción, que es el caso que
    // originó esto: los dos corren NODE_ENV=production.
    entorno:     process.env.AWS_SECRETS_NAME ? 'produccion-vps' : 'no-produccion',
    arrancado:   new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
  };
}

export default buildInfo;
