/**
 * withdrawalLiquidity.js — No prometer un retiro que la tesorería no puede pagar.
 *
 * Es el equivalente de salida de `payoutPreflight`. Todo el día 2026-10-09 se
 * corrigió el mismo patrón del lado de la entrada —cobrar sin verificar que el
 * payout era ejecutable— y del lado del retiro seguía igual: `requestWithdrawal`
 * validaba contra el saldo de la billetera del usuario y **nada más**, sin mirar
 * si el banco tenía el dinero.
 *
 * No era teórico. Al 2026-10-10 el pasivo BOB era de Bs 4.227 contra Bs 1.047,61
 * en la cuenta: cobertura 25%. Un usuario con Bs 2.280 de saldo podía pedir el
 * retiro, el sistema lo aceptaba y reservaba, y recién al ir a transferir se
 * descubría que no había con qué.
 *
 * ── Qué compara ─────────────────────────────────────────────────────────────
 *
 * No alcanza con `saldo del banco >= monto`. Los retiros se ejecutan a mano
 * (BANECO no expone dispersión: `capabilities.disburse = false`), así que entre
 * que se acepta uno y se transfiere pueden aceptarse otros. Cada uno pasaría el
 * control por separado y entre todos vaciarían la cuenta.
 *
 * Por eso se descuenta lo ya prometido y no transferido:
 *
 *     liquidez = saldo del banco − retiros en 'pending' o 'dispatched'
 *
 * ── Falla ABIERTO ───────────────────────────────────────────────────────────
 *
 * Si no se puede leer el saldo del banco, deja pasar. Dos razones: bloquear a
 * todos los usuarios el acceso a su dinero porque la API de BANECO no responde
 * es peor que el problema, y además el retiro **no mueve plata por sí solo** —
 * lo ejecuta un admin a mano, que es el control final. El guard adelanta el
 * rechazo, no lo sustituye.
 */

import WalletTransaction from '../models/WalletTransaction.js';
import { logger } from '../utils/logger.js';

/** Kill switch. `false` restaura el comportamiento previo. */
function habilitado() {
  return String(process.env.WITHDRAWAL_LIQUIDITY_GUARD_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/** Estados en los que un retiro ya está prometido pero todavía no salió del banco. */
const PROMETIDOS = ['pending', 'dispatched'];

const TTL_MS = 60 * 1000;
let _cache = { at: 0, saldo: null };

/** Solo para pruebas. */
export function _resetCache() { _cache = { at: 0, saldo: null }; }

/**
 * Saldo disponible en la cuenta del banco.
 *
 * @returns {Promise<number|null>} null si no se pudo determinar
 */
async function saldoBanco() {
  if (Date.now() - _cache.at < TTL_MS) return _cache.saldo;

  try {
    const { getBalance, isAvailable } = await import('./bank/becAccountService.js');
    if (!isAvailable?.()) return null;              // sin credenciales no se afirma nada

    const b = await getBalance();

    // ⚠️ `Number(null)` es 0, no NaN. Sin este chequeo explícito, un saldo que el
    // banco no informa se leería como "cuenta en cero" y bloquearía todos los
    // retiros. Es el mismo error que se cometió en `payoutPreflight` tratando
    // una moneda sin tasa como capacidad cero: **no medible no es cero**.
    const crudo = b?.available;
    if (crudo === null || crudo === undefined || crudo === '') return null;

    const v = Number(crudo);
    if (!Number.isFinite(v)) return null;           // no se cachea lo indeterminado
    const saldo = v;

    _cache = { at: Date.now(), saldo };
    return saldo;
  } catch (err) {
    logger.warn('[withdrawalLiquidity] No se pudo leer el saldo del banco, se deja pasar', {
      error: err?.message,
    });
    return null;
  }
}

/**
 * ¿La tesorería puede honrar este retiro?
 *
 * @param {object} params
 * @param {number} params.amount    — monto solicitado
 * @param {string} [params.currency]— solo se controla BOB (es la cuenta del banco)
 * @returns {Promise<{ok: boolean, motivo?: string, detalle?: object}>}
 */
export async function verificarLiquidezRetiro({ amount, currency = 'BOB' } = {}) {
  if (!habilitado()) return { ok: true };
  if (String(currency).toUpperCase() !== 'BOB') return { ok: true };

  const monto = Number(amount);
  if (!Number.isFinite(monto) || monto <= 0) return { ok: true };

  const saldo = await saldoBanco();
  if (saldo === null) return { ok: true };          // indeterminado → pasa

  let prometido = 0;
  try {
    const agg = await WalletTransaction.aggregate([
      { $match: { type: 'withdrawal', status: { $in: PROMETIDOS }, currency: { $ne: 'USDC' } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    prometido = Number(agg[0]?.total ?? 0);
  } catch (err) {
    // Sin poder leer lo prometido, el control queda incompleto. Se sigue con
    // saldo a secas en vez de abandonar: es más estricto que no controlar nada.
    logger.warn('[withdrawalLiquidity] No se pudo sumar lo ya prometido', { error: err?.message });
  }

  const disponible = saldo - prometido;

  if (monto > disponible) {
    return {
      ok:     false,
      motivo: 'tesoreria-insuficiente',
      detalle: {
        solicitadoBob:  monto,
        disponibleBob:  Number(disponible.toFixed(2)),
        saldoBancoBob:  Number(saldo.toFixed(2)),
        prometidoBob:   Number(prometido.toFixed(2)),
      },
    };
  }

  return { ok: true };
}
