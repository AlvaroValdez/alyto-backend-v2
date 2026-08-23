/**
 * sep24Fees.js — Comisión del retiro SEP-24, resuelta desde la configuración.
 *
 * El 6,5% estaba fijo en DOS lugares de `sep24Service`, en unidades distintas: el
 * `/info` lo publicaba como `fee_percent: 6.5` y `/fee` lo calculaba con `0.065`.
 * Hoy coinciden, pero nada lo garantizaba: cambiar uno no propagaba al otro, y el
 * consumidor podía recibir una comisión distinta de la publicada por el anchor.
 *
 * Además ninguno de los dos seguía al tarifario: si el spread de los corredores
 * cambia desde el panel, el anchor seguía anunciando 6,5%.
 *
 * Fundamento: apdo. 5.4 del Informe Técnico —"todo importe descontado se informa"— y
 * la observación de publicidad engañosa en comisiones que ya pesa sobre la entidad.
 *
 * ── Cómo se resuelve ────────────────────────────────────────────────────────────
 *
 * Se toma el `alytoCSpread` de los corredores SRL activos. Si divergen entre sí, se
 * usa el **mayor**, y es deliberado: la comisión publicada es un techo. Que a un
 * consumidor se le cobre MENOS de lo anunciado es admisible; que se le cobre más, no.
 * Publicar el promedio o el mínimo produciría exactamente ese segundo caso.
 *
 * La divergencia se registra: un tarifario disperso es una señal, no un estado normal.
 */

import { logger } from '../utils/logger.js';

/** Valor de resguardo si la configuración no puede leerse. Ver `resolveWithdrawFeePercent`. */
const FALLBACK_PERCENT = Number(process.env.SEP24_WITHDRAW_FEE_PERCENT) || 6.5;

/** Vigencia del valor memoizado. El tarifario cambia por acción administrativa, no solo. */
const TTL_MS = 5 * 60 * 1000;

let _cache = { value: null, at: 0 };

export function __resetSep24FeeCacheForTest() {
  _cache = { value: null, at: 0 };
}

/**
 * Comisión porcentual del retiro SEP-24, en puntos porcentuales (6.5 = 6,5%).
 *
 * FALLBACK, no fail-closed: a diferencia de los límites del ECP, acá no se puede
 * rechazar. `/info` es un documento de descubrimiento que el ecosistema Stellar
 * consulta sin sesión, y devolverlo vacío rompería la interoperabilidad del anchor
 * sin proteger a nadie. Se devuelve el valor de resguardo y se registra el fallo.
 *
 * @returns {Promise<number>}
 */
export async function resolveWithdrawFeePercent() {
  if (_cache.value != null && Date.now() - _cache.at < TTL_MS) return _cache.value;

  try {
    const { default: TransactionConfig } = await import('../models/TransactionConfig.js');
    const corredores = await TransactionConfig
      .find({ legalEntity: 'SRL', isActive: true })
      .select('corridorId alytoCSpread')
      .lean();

    const spreads = corredores
      .map(c => Number(c.alytoCSpread))
      .filter(n => Number.isFinite(n) && n > 0);

    if (spreads.length === 0) {
      logger?.warn?.('[SEP-24] Sin spread configurado en corredores SRL; se usa el valor de resguardo', {
        fallback: FALLBACK_PERCENT,
      });
      _cache = { value: FALLBACK_PERCENT, at: Date.now() };
      return FALLBACK_PERCENT;
    }

    const maximo = Math.max(...spreads);
    const minimo = Math.min(...spreads);

    if (maximo !== minimo) {
      logger?.warn?.('[SEP-24] Tarifario disperso entre corredores SRL; se publica el mayor', {
        minimo, maximo, corredores: spreads.length,
      });
    }

    _cache = { value: maximo, at: Date.now() };
    return maximo;

  } catch (err) {
    logger?.error?.('[SEP-24] No se pudo leer el tarifario; se usa el valor de resguardo', {
      err: err.message, fallback: FALLBACK_PERCENT,
    });
    return FALLBACK_PERCENT;
  }
}

/**
 * La misma comisión expresada como fracción (0.065 = 6,5%).
 *
 * Existe para que `/info` y `/fee` **no puedan divergir**: ambos derivan del mismo
 * valor, y la conversión de unidad ocurre en un solo lugar. Ese era el defecto que
 * este módulo corrige.
 */
export async function resolveWithdrawFeeFraction() {
  return (await resolveWithdrawFeePercent()) / 100;
}

/**
 * Comisión aplicable a un importe. Función pura para poder probar el redondeo sin
 * depender de la configuración.
 *
 * @param {{ amount:number, feePercent:number }} p
 * @returns {number} comisión con dos decimales
 */
export function computeFee({ amount, feePercent }) {
  const monto = Number(amount);
  const pct   = Number(feePercent);
  if (!Number.isFinite(monto) || monto <= 0) return 0;
  if (!Number.isFinite(pct)  || pct  <= 0) return 0;
  return Math.round(monto * (pct / 100) * 100) / 100;
}

export default {
  resolveWithdrawFeePercent,
  resolveWithdrawFeeFraction,
  computeFee,
  __resetSep24FeeCacheForTest,
};
