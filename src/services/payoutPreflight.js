/**
 * payoutPreflight.js — No cobrar lo que no vamos a poder pagar.
 *
 * El 2026-10-01 aparecieron 7 operaciones por Bs 3.506 en las que el payin se
 * cobró y el payout nunca se ejecutó. Dos de ellas murieron con
 * `"Insufficient balance business"`: la wallet maestra de Vita, de la que salen
 * los payouts de los 17 corredores LatAm, estaba sin saldo. El dinero del
 * usuario ya estaba adentro cuando lo descubrimos.
 *
 * El patrón de fondo es ese: **se confirma el payin antes de saber si el payout
 * es ejecutable**. Devolver el dinero cierra el caso puntual pero no impide que
 * vuelva a pasar; esto sí.
 *
 * ── Dónde se verifica, y por qué ahí ────────────────────────────────────────
 *
 * En `initCrossBorderPayment`, ANTES de emitir instrucciones de pago o generar
 * el QR bancario. Es el último momento en que todavía no se movió un centavo.
 *
 * No sirve verificar al llegar el IPN: para el QR bancario, cuando el banco
 * notifica, la plata YA está en la cuenta. Ahí rechazar la confirmación sería
 * peor, porque dejaría el dinero adentro y sin transacción que lo respalde.
 *
 * ── Qué hace y qué NO hace ──────────────────────────────────────────────────
 *
 * Bloquea solo ante un **negativo comprobado**: leímos el saldo y no alcanza.
 * Si no se puede determinar (Vita no responde, timeout, formato inesperado),
 * **deja pasar**. Un proveedor de monitoreo caído no puede cerrar la caja: el
 * costo de bloquear a todos los usuarios por no poder consultar un saldo es
 * mayor que el de un payout fallido, que además ya tiene su red de contención.
 *
 * No cubre el riel de Harbor. Esas dos operaciones fallaron por
 * `"On behalf of customer is not active"`, que es un estado del customer en
 * Harbor y no se puede deducir sin llamarlos. Harbor además degrada distinto:
 * ante falta de liquidez la transacción queda en `pending_funding` y se
 * reintenta sola cuando entra el fondeo, que es un estado recuperable, no una
 * pérdida. Queda pendiente y anotado, no resuelto a medias.
 */

import { getWallets } from './vitaWalletService.js';
import { logger } from '../utils/logger.js';

/** Kill switch. Ante cualquier duda en producción, `false` restaura el comportamiento previo. */
function habilitado() {
  return String(process.env.PAYOUT_PREFLIGHT_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Caché corta del saldo de Vita.
 *
 * `getWallets()` no cachea, y esto corre en el camino de cada inicio de pago.
 * 60 s es suficiente para no golpear a Vita en cada request y lo bastante corto
 * para que un saldo que se agota no quede escondido mucho tiempo.
 */
const TTL_SALDO_MS = 60 * 1000;
let _cache = { at: 0, usd: null };

/**
 * Saldo USD de la wallet maestra de Vita.
 *
 * @returns {Promise<number|null>} null si no se pudo determinar
 */
async function saldoUsdVita() {
  if (Date.now() - _cache.at < TTL_SALDO_MS) return _cache.usd;

  try {
    const r = await getWallets();
    const wallets = Array.isArray(r?.wallets) ? r.wallets : [];
    // La master es la que paga; si hubiera varias, nos quedamos con esa.
    const master = wallets.find((w) => w?.attributes?.is_master) ?? wallets[0];
    const usd = master?.attributes?.balances?.usd;
    const valor = Number.isFinite(Number(usd)) ? Number(usd) : null;
    _cache = { at: Date.now(), usd: valor };
    return valor;
  } catch (err) {
    logger.warn('[payoutPreflight] No se pudo leer el saldo de Vita, se deja pasar', {
      error: err?.message,
    });
    // No se cachea el fallo: la próxima request vuelve a intentar.
    return null;
  }
}

/** Solo para pruebas: olvida el saldo cacheado. */
export function _resetCache() {
  _cache = { at: 0, usd: null };
}

/**
 * ¿Podemos comprometernos a ejecutar este payout?
 *
 * @param {object}  params
 * @param {object}  params.corridor   — TransactionConfig del corredor
 * @param {number}  params.usdAmount  — monto que se le enviaría al proveedor, en USD
 * @returns {Promise<{ok: boolean, motivo?: string, detalle?: object}>}
 */
export async function verificarPayoutEjecutable({ corridor, usdAmount } = {}) {
  if (!habilitado()) return { ok: true };
  if (!corridor) return { ok: true };

  // Sin un monto confiable no hay nada que comparar. Dejar pasar es correcto:
  // `dispatchPayout` recalcula el monto server-side al despachar.
  const monto = Number(usdAmount);
  if (!Number.isFinite(monto) || monto <= 0) return { ok: true };

  if (corridor.payoutMethod === 'vitaWallet') {
    const saldo = await saldoUsdVita();
    if (saldo === null) return { ok: true };          // indeterminado → pasa

    if (saldo < monto) {
      return {
        ok:     false,
        motivo: 'vita-saldo-insuficiente',
        detalle: { saldoUsd: saldo, requeridoUsd: monto, corridorId: corridor.corridorId },
      };
    }
  }

  return { ok: true };
}
