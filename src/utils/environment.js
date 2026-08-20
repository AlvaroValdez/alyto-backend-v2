/**
 * environment.js — Discriminación de entorno para funciones que simulan
 * eventos externos.
 *
 * ⚠️ `NODE_ENV === 'production'` NO alcanza como discriminador en este repo:
 * Render staging TAMBIÉN corre NODE_ENV=production a propósito (render.yaml),
 * y ahí las simulaciones son la herramienta de prueba del flujo. El VPS de
 * producción real es el ÚNICO entorno que carga AWS Secrets Manager — mismo
 * criterio que el ProviderGuard y el DbGuard de server.js.
 *
 * ⚠️ El entorno se lee DENTRO de las funciones (regla 21 de CLAUDE.md):
 * capturarlo en el ámbito de módulo lo congelaría antes de que Secrets Manager
 * pueble process.env, y la política decidiría con datos previos al bootstrap.
 */

/**
 * NODE_ENV que declaran explícitamente un entorno de desarrollo.
 * Se comparan en minúsculas y sin espacios.
 */
const NON_PRODUCTION_NODE_ENV = new Set(['development', 'dev', 'test', 'local']);

/**
 * ¿Este proceso es el VPS de producción real?
 *
 * Señal principal: `AWS_SECRETS_NAME`. Es POSITIVA (presencia de algo), no una
 * negación de NODE_ENV — por eso no se la burla escribiendo 'Production',
 * 'prod' o dejando NODE_ENV sin setear, que es como fallan los guards ingenuos.
 *
 * ⚠️ Pero un NODE_ENV explícitamente de desarrollo tiene prioridad: el `.env`
 * del repo (y `.env.example`) traen `NODE_ENV=development` JUNTO A
 * `AWS_SECRETS_NAME=alyto/production`, porque en local se leen los secretos
 * desde AWS. Sin esta precedencia, cualquier máquina de desarrollo quedaría
 * clasificada como el VPS y se apagarían los simuladores en dev.
 *
 * El riesgo residual (poner NODE_ENV=development en el VPS) es un acto
 * explícito que además desarma los guards de CORS, cookies y proveedores de
 * server.js — no es un pie silencioso.
 *
 * @returns {boolean}
 */
export function isRealProductionEnv() {
  const nodeEnv = String(process.env.NODE_ENV ?? '').trim().toLowerCase();
  if (NON_PRODUCTION_NODE_ENV.has(nodeEnv)) return false;
  return !!process.env.AWS_SECRETS_NAME;
}

/**
 * ¿Se permite fabricar el efecto de un evento externo en este entorno?
 *
 * Aplica a los endpoints `simulate*` del panel admin y a la rama de
 * autoconfirmación de payouts de `dispatchPayout`. Todos comparten el mismo
 * riesgo: dan por ocurrido un cobro/liquidación que nadie ejecutó.
 *
 * Política (fail-closed sobre la señal más fuerte):
 *   producción real (Secrets Manager)  → DENEGADO siempre, sin escape hatch
 *   NODE_ENV=production sin secretos   → staging tipo Render: denegado salvo opt-in
 *   resto (dev / test / staging local) → permitido
 *
 * @returns {boolean}
 */
export function areSimulatorsAllowed() {
  // Sin escape hatch a propósito: en el VPS estas rutas crean saldo y dan por
  // liquidadas operaciones sobre fondos de terceros bajo custodia.
  if (isRealProductionEnv()) return false;
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.ALYTO_SANDBOX_SIMULATORS === 'true';
}

/**
 * ¿Debe `dispatchPayout` autoconfirmar el payout sin esperar el IPN del proveedor?
 *
 * La rama de simulación de dispatchPayout marca la transacción como 'completed'
 * 4 s después de que el proveedor aceptó la orden, emite el comprobante y
 * notifica al usuario — sin que nadie haya confirmado que el dinero llegó.
 *
 * Se pide con `VITA_ENVIRONMENT=sandbox`, pero eso NO alcanza para concederlo:
 * ese es el valor que trae el template de entorno de CLAUDE.md §7, así que un
 * copiar/pegar al VPS convertiría todos los payouts en liquidaciones ficticias
 * con comprobante. En producción real se ignora y se espera el IPN de verdad.
 *
 * @param {string} [vitaEnvironment] — inyectable para test; por defecto el entorno
 * @returns {boolean}
 */
export function shouldSimulatePayoutConfirmation(vitaEnvironment = process.env.VITA_ENVIRONMENT) {
  return vitaEnvironment === 'sandbox' && areSimulatorsAllowed();
}
