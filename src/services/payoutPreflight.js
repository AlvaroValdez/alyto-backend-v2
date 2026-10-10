/**
 * payoutPreflight.js — No cobrar lo que no vamos a poder pagar.
 *
 * El 2026-10-01 aparecieron 7 operaciones por Bs 3.506 en las que el payin se
 * cobró y el payout nunca se ejecutó. Dos murieron con
 * `"Insufficient balance business"`: la wallet maestra de Vita, de la que salen
 * los payouts de los 17 corredores LatAm, estaba sin saldo. El dinero del
 * usuario ya estaba adentro cuando lo descubrimos.
 *
 * ── Dónde se verifica, y por qué ahí ────────────────────────────────────────
 *
 * En `initCrossBorderPayment`, ANTES de emitir instrucciones de pago o generar
 * el QR bancario. Es el último momento en que todavía no se movió un centavo.
 * No sirve verificar al llegar el IPN: para el QR bancario, cuando el banco
 * notifica, la plata YA está en la cuenta.
 *
 * ── Por qué mira TODAS las monedas y no solo USD ────────────────────────────
 *
 * ⚠️ La primera versión comparaba el monto contra `balances.usd` a secas. Estaba
 * mal, y de la peor manera: el 2026-10-09 la wallet tenía USD 4,28 y
 * CLP 466.110. Con el gate encendido habría bloqueado los 17 corredores Vita
 * estando perfectamente fondeada, porque el saldo que paga es el de CLP.
 *
 * Vita debita de UNA de sus monedas, no de la suma. Cuál, lo decide
 * `vitaPayoutCurrency` del corredor, y en `'auto'` lo elige Vita. Así que la
 * capacidad real es **el mejor saldo**, no el total ni el de USD.
 *
 * La conversión usa las tasas que publica la propia Vita en `/prices`
 * (`<moneda>_sell` hacia un destino en USD), no una tabla nuestra: comparar
 * contra su saldo con una tasa ajena es volver a equivocarse de número.
 *
 * ── Qué hace y qué NO hace ──────────────────────────────────────────────────
 *
 * Bloquea solo ante un **negativo comprobado**: pudimos leer saldos y tasas, y
 * ni el mejor saldo alcanza. Ante cualquier indeterminación —Vita no responde,
 * falta la tasa de una moneda, el formato cambió— **deja pasar**. Un proveedor
 * de monitoreo caído no puede cerrar la caja: bloquear a todos los usuarios por
 * no poder leer un saldo cuesta más que un payout fallido, que además tiene su
 * propia red de contención.
 *
 * No cubre el riel de Harbor, que degrada distinto: ante falta de liquidez queda
 * en `pending_funding` y se reintenta solo cuando entra el fondeo. Eso es
 * recuperable, no una pérdida.
 *
 * Tampoco cubre los datos del beneficiario. El 2026-10-09 dos operaciones se
 * cobraron y fallaron por `document_number` y `pix_key_type` inválidos, que Vita
 * valida recién al pagar. Es la misma familia de problema y está pendiente.
 */

import { getWallets, getPrices } from './vitaWalletService.js';
import { logger } from '../utils/logger.js';

/** Kill switch. Ante cualquier duda en producción, `false` restaura el comportamiento previo. */
function habilitado() {
  return String(process.env.PAYOUT_PREFLIGHT_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/** Monedas de Vita que ya están en dólares: no necesitan conversión. */
const EQUIVALEN_A_USD = new Set(['usd', 'usdc', 'usdt']);

/**
 * Destinos de `/prices` denominados en USD. Sirven para derivar cuánto vale en
 * dólares una unidad de cada moneda, usando la tasa de la propia Vita.
 */
const DESTINOS_USD = ['arusd', 'swiftusd', 'uswires', 'cnusd', 'causd', 'euusd', 'us', 'hkusd', 'peusd'];

const TTL_MS = 60 * 1000;
let _cache = { at: 0, valor: null };

/** Solo para pruebas: olvida lo cacheado. */
export function _resetCache() {
  _cache = { at: 0, valor: null };
}

/**
 * Capacidad de pago de la wallet maestra, por moneda, expresada en USD.
 *
 * Una moneda aparece en el resultado solo si se la pudo **medir**. La distinción
 * entre "no hay capacidad" y "no se pudo medir" es la que decide si se bloquea
 * un cobro, así que no se puede perder.
 *
 * @returns {Promise<Record<string, number>|null>} null si no se pudo determinar nada
 */
async function capacidadPorMoneda() {
  if (Date.now() - _cache.at < TTL_MS) return _cache.valor;

  try {
    const [wallets, precios] = await Promise.all([getWallets(), getPrices()]);

    const master = (wallets?.wallets ?? []).find((w) => w?.attributes?.is_master)
      ?? (wallets?.wallets ?? [])[0];
    const balances = master?.attributes?.balances;
    if (!balances || typeof balances !== 'object') return null;

    const capacidad = {};
    for (const [moneda, saldoCrudo] of Object.entries(balances)) {
      const saldo = Number(saldoCrudo);
      if (!Number.isFinite(saldo)) continue;

      // Un saldo en cero SÍ es medible: vale cero dólares y no necesita tasa.
      // Omitirlo volvería indistinguible "la wallet está vacía" de "no pudimos
      // medirla", y el primero debe bloquear mientras el segundo debe pasar.
      if (saldo <= 0) { capacidad[moneda] = 0; continue; }

      if (EQUIVALEN_A_USD.has(moneda)) { capacidad[moneda] = saldo; continue; }

      const venta = precios?.[moneda]?.withdrawal?.prices?.attributes?.[`${moneda}_sell`];
      const tasas = DESTINOS_USD.map((d) => Number(venta?.[d])).filter((n) => Number.isFinite(n) && n > 0);
      // Saldo positivo sin tasa: no se puede valuar. Se omite en vez de asumir
      // cero, que sería inventar una insuficiencia.
      if (!tasas.length) continue;

      // La más favorable: si vamos a bloquear un cobro, que no sea por haber
      // elegido la peor conversión posible.
      capacidad[moneda] = saldo * Math.max(...tasas);
    }

    _cache = { at: Date.now(), valor: capacidad };
    return capacidad;
  } catch (err) {
    logger.warn('[payoutPreflight] No se pudo leer la capacidad de Vita, se deja pasar', {
      error: err?.message,
    });
    // No se cachea el fallo: la próxima request vuelve a intentar.
    return null;
  }
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
  if (corridor.payoutMethod !== 'vitaWallet') return { ok: true };

  // Sin un monto confiable no hay nada que comparar. Dejar pasar es correcto:
  // `dispatchPayout` recalcula el monto server-side al despachar.
  const monto = Number(usdAmount);
  if (!Number.isFinite(monto) || monto <= 0) return { ok: true };

  const capacidad = await capacidadPorMoneda();
  if (!capacidad) return { ok: true };                      // indeterminado → pasa

  // De qué saldo sale el pago. `'auto'` (o sin definir) = lo elige Vita, así que
  // la capacidad es la del mejor saldo disponible.
  const elegida = String(corridor.vitaPayoutCurrency ?? 'auto').toLowerCase();
  const esAuto  = elegida === 'auto' || elegida === '';

  let disponible;
  if (esAuto) {
    const valores = Object.values(capacidad);
    if (!valores.length) return { ok: true };               // nada medible → pasa
    disponible = Math.max(...valores);
  } else {
    disponible = capacidad[elegida];
    // La moneda configurada no se pudo medir: no afirmamos que falte.
    if (!Number.isFinite(disponible)) return { ok: true };
  }

  if (disponible < monto) {
    return {
      ok:     false,
      motivo: 'vita-saldo-insuficiente',
      detalle: {
        disponibleUsd: Number(disponible.toFixed(2)),
        requeridoUsd:  monto,
        moneda:        esAuto ? 'auto' : elegida,
        capacidad,
        corridorId:    corridor.corridorId,
      },
    };
  }

  return { ok: true };
}
