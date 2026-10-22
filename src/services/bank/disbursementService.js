/**
 * disbursementService.js — Ordenar una salida de bolivianos, sea cual sea el flujo.
 *
 * ## Por qué existe
 *
 * El despacho de dispersión ya era *bank-agnostic*: el proveedor se resuelve en
 * `bankRegistry` y sumar un banco es un adapter más una línea. Lo que no era es
 * *flow-agnostic*: todo eso vivía dentro de `adminDispatchWithdrawal`, así que el
 * único flujo capaz de mandar bolivianos era el retiro de billetera.
 *
 * Hay al menos dos más que hoy se liquidan a mano:
 *
 *   - **Devolución** de una operación no completada. Hoy un admin fuerza el
 *     estado a `refunded`, que como dice el propio comentario de
 *     `adminController` es "afirmar que el dinero llegó". Nadie verifica que
 *     haya llegado.
 *   - **Corredor Chile a Bolivia**: entra en pesos por Fintoc y alguien paga los
 *     bolivianos del otro lado. Su provider lo declara sin vueltas: "No llama a
 *     ninguna API externa, el procesamiento es humano/manual".
 *
 * Este módulo es el pedazo genérico de ese despacho, para que los tres flujos
 * ordenen una salida igual y lo que venga después herede el riel sin integrar
 * nada.
 *
 * ## El reparto: la secuencia es de acá, la semántica es del consumidor
 *
 * Este servicio **no sabe** qué significa "reclamar" para cada flujo: un retiro
 * va `pending → dispatched`, una devolución va hacia `refunded`, el corredor
 * tiene sus propios estados. Eso lo pone el consumidor en los callbacks `claim`
 * y `revert`.
 *
 * Lo que sí es de acá es **el orden**, porque el orden es la propiedad de
 * seguridad:
 *
 *   1. validar lo barato y determinístico — todavía no se tocó nada;
 *   2. resolver proveedor y liquidez;
 *   3. recién entonces `claim()`, que es el guard atómico contra doble salida;
 *   4. ordenar al banco;
 *   5. `revert()` solo si el banco falló.
 *
 * Que el paso 1 vaya antes del 3 no es cosmético. El error más probable hoy es
 * que falte el documento del beneficiario, porque Red Enlace lo exige y el
 * frontend todavía no lo captura. Validar después de reclamar dejaría cada uno
 * de esos intentos en estado reclamado, dependiendo de que la reversión no
 * falle. Para el error más frecuente eso es un mal canje.
 *
 * Si cada consumidor reimplementara esta secuencia, alguno la va a equivocar, y
 * el síntoma sería plata que sale dos veces o un registro que queda trabado sin
 * orden en el banco.
 *
 * **No lanza por causas operativas.** Devuelve un resultado discriminado. Si
 * lanzara, cada consumidor tendría que leer mensajes de error para decidir qué
 * hacer, y un cambio de texto en una validación río abajo se convertiría en un
 * retiro atascado.
 *
 * **No pone texto de AML por omisión.** El origen y destino de fondos son
 * declaraciones, no relleno. El texto que usa el retiro de billetera
 * ("Conversión de activos virtuales en billetera Alyto") sería falso en una
 * devolución, donde el dinero vuelve a quien lo puso. Un default acá terminaría
 * declarándole al banco algo que no pasó, así que se exige explícito.
 */

import { getDisbursementAdapter } from './bankRegistry.js';
import { logger }                 from '../../utils/logger.js';

/**
 * Motivos admitidos. No es burocracia: viaja al log y a la glosa, y es lo que
 * después permite separar en la conciliación un retiro de una devolución, que
 * ante el banco son dos débitos idénticos.
 */
export const PURPOSES = Object.freeze({
  WALLET_WITHDRAWAL: 'wallet_withdrawal',
  REFUND:            'refund',
  CORRIDOR_PAYOUT:   'corridor_payout',
});

const PURPOSE_VALUES = Object.values(PURPOSES);

/** Modelo donde vive el registro que origina la salida. */
const TARGET_MODELS = ['Transaction', 'WalletTransaction'];

/**
 * Códigos de falla. El consumidor decide su propio HTTP y su propia reversión a
 * partir de esto, no del mensaje.
 */
export const PAYOUT_ERRORS = Object.freeze({
  NO_PROVIDER:            'no_provider',
  INVALID_REQUEST:        'invalid_request',
  INSUFFICIENT_LIQUIDITY: 'insufficient_liquidity',
  /** `claim()` devolvió false: otro proceso ya se quedó con la operación. */
  ALREADY_CLAIMED:        'already_claimed',
  PROVIDER_ERROR:         'provider_error',
});

/** Traducción a HTTP, para que los controladores no la repitan distinto cada uno. */
const HTTP_BY_CODE = {
  [PAYOUT_ERRORS.NO_PROVIDER]:            501,
  [PAYOUT_ERRORS.INVALID_REQUEST]:        400,
  [PAYOUT_ERRORS.INSUFFICIENT_LIQUIDITY]: 409,
  [PAYOUT_ERRORS.ALREADY_CLAIMED]:        409,
  [PAYOUT_ERRORS.PROVIDER_ERROR]:         502,
};

/** @returns {number} status HTTP para un código de falla. */
export function httpStatusFor(code) {
  return HTTP_BY_CODE[code] ?? 500;
}

const fail = (code, reason, retryable) => ({ ok: false, code, reason, retryable });

/**
 * ¿Está encendido el pre-check de liquidez?
 * Se lee dentro de la función (regla 21): un `const` de módulo capturaría el
 * valor previo a la carga de Secrets Manager y caería al default en silencio.
 * `WALLET_BANECO_LIQUIDITY_CHECK` sigue vivo por compatibilidad con lo que ya
 * está provisionado.
 */
function liquidityCheckEnabled() {
  return process.env.WALLET_BANK_LIQUIDITY_CHECK === 'true'
      || process.env.WALLET_BANECO_LIQUIDITY_CHECK === 'true';
}

/**
 * Ordena una salida de bolivianos a una cuenta bancaria.
 *
 * Si el resultado trae `retryable: true`, no se movió dinero: o no se llegó a
 * reclamar, o se reclamó y ya se revirtió con el callback.
 *
 * @param {object} p
 * @param {string}  [p.provider]      — proveedor; omitido usa el default del registro.
 * @param {string}   p.reference      — identificador nuestro de la operación (wtxId, alytoTransactionId).
 * @param {'Transaction'|'WalletTransaction'} p.targetModel — dónde vive ese identificador.
 * @param {number}   p.amount         — monto en bolivianos, > 0.
 * @param {string}  [p.currency]      — 'BOB'.
 * @param {string}   p.purpose        — uno de PURPOSES.
 * @param {string}  [p.description]   — glosa; el adapter recorta a lo que admita el banco.
 * @param {object}   p.beneficiary    — { accountCode, bankCode, name, accountType?, docId?, email? }
 * @param {object}   p.amlData        — { source, destination }; obligatorio, sin default.
 * @param {boolean} [p.liquidityCheck]— fuerza o saltea el pre-check; omitido usa el gate de entorno.
 * @param {(ctx: {provider: string}) => Promise<boolean>} [p.claim] — guard atómico del
 *        consumidor; false = ya lo tomó otro. Recibe el proveedor resuelto para
 *        que lo persista en el mismo write.
 * @param {() => Promise<void>}    [p.revert] — deshace el claim; se llama solo si el banco falló.
 *
 * @returns {Promise<
 *   { ok: true,  provider: string, bankBatchId: string, reference?: string, mock: boolean }
 * | { ok: false, code: string, reason: string, retryable: boolean }
 * >}
 */
export async function orderPayout(p = {}) {
  const {
    provider, reference, targetModel, amount, currency = 'BOB',
    purpose, description, beneficiary, amlData, liquidityCheck,
    claim, revert,
  } = p;

  // ── Validación de la orden ──────────────────────────────────────────────────
  // Lo que se valida acá es el contrato de ESTE servicio. Las reglas de formato
  // de cada banco (largo de la glosa, documento obligatorio, sucursal válida)
  // viven en su adapter, que es quien las conoce.
  if (!reference)                        return fail(PAYOUT_ERRORS.INVALID_REQUEST, 'reference es requerido', true);
  if (!TARGET_MODELS.includes(targetModel)) {
    return fail(PAYOUT_ERRORS.INVALID_REQUEST, `targetModel inválido '${targetModel}'; válidos: ${TARGET_MODELS.join(', ')}`, true);
  }
  if (!PURPOSE_VALUES.includes(purpose)) {
    return fail(PAYOUT_ERRORS.INVALID_REQUEST, `purpose inválido '${purpose}'; válidos: ${PURPOSE_VALUES.join(', ')}`, true);
  }
  if (!(Number(amount) > 0))             return fail(PAYOUT_ERRORS.INVALID_REQUEST, 'amount debe ser > 0', true);
  if (!beneficiary?.accountCode)         return fail(PAYOUT_ERRORS.INVALID_REQUEST, 'beneficiary.accountCode es requerido', true);
  if (!beneficiary?.bankCode) {
    return fail(PAYOUT_ERRORS.INVALID_REQUEST, 'beneficiary.bankCode (código ASFI de la entidad destino) es requerido', true);
  }
  // Sin esto el banco recibe una declaración vacía de origen y destino de fondos.
  if (!amlData?.source || !amlData?.destination) {
    return fail(
      PAYOUT_ERRORS.INVALID_REQUEST,
      'amlData.source y amlData.destination son obligatorios: son la declaración de origen y destino de fondos, y no admiten un valor por omisión',
      true,
    );
  }

  // ── Proveedor ───────────────────────────────────────────────────────────────
  const resolved = getDisbursementAdapter(provider);
  if (!resolved) {
    return fail(
      PAYOUT_ERRORS.NO_PROVIDER,
      `Sin proveedor de dispersión para '${provider ?? 'default'}'.`,
      true,
    );
  }

  // ── Pre-check de liquidez ───────────────────────────────────────────────────
  // Fail-open deliberado: solo bloquea si la consulta responde y el saldo no
  // alcanza. Un proveedor que no contesta no debe frenar una salida legítima,
  // porque el riel igual rechaza el lote si no hay fondos.
  const checkLiquidity = liquidityCheck ?? liquidityCheckEnabled();
  if (checkLiquidity && typeof resolved.adapter.tryGetAvailableBalance === 'function') {
    const { available, ok } = await resolved.adapter.tryGetAvailableBalance();
    if (ok && available != null && available < Number(amount)) {
      return fail(
        PAYOUT_ERRORS.INSUFFICIENT_LIQUIDITY,
        `Liquidez BOB insuficiente en ${resolved.provider}. Disponible: Bs. ${Number(available).toFixed(2)}, requerido: Bs. ${Number(amount).toFixed(2)}.`,
        true,
      );
    }
  }

  // ── Guard atómico ───────────────────────────────────────────────────────────
  // Recién acá se toca estado, y solo después de que todo lo determinístico
  // pasó. El consumidor pone el `claim` porque es el único que sabe qué
  // transición es válida en su modelo; lo que garantiza este orden es que un
  // rechazo por formato no deje nada reclamado.
  // Se le pasa el proveedor ya resuelto para que el consumidor lo guarde en el
  // mismo write del claim. No es un extra: la red de seguridad lee
  // `metadata.disbursementProvider` y, si no está, no puede preguntarle al banco
  // y se limita a alertar. Anotarlo después del claim abriría una ventana en la
  // que una operación reclamada no es resoluble sola.
  if (typeof claim === 'function') {
    const claimed = await claim({ provider: resolved.provider });
    if (!claimed) {
      return fail(
        PAYOUT_ERRORS.ALREADY_CLAIMED,
        'La operación ya fue tomada por otro proceso.',
        false,   // no revertir: el estado es de quien la tomó, no nuestro
      );
    }
  }

  // ── Orden al banco ──────────────────────────────────────────────────────────
  let result;
  try {
    result = await resolved.disbursement.transfer({
      batchId:       reference,
      batchDetailId: reference,
      targetModel,
      amount:        Number(amount),
      currency,
      description,
      purpose,
      beneficiary,
      amlData,
    });
  } catch (err) {
    // Que el adapter haya lanzado significa que no llegó a ordenar, o que no
    // sabemos si llegó. En ambos casos conviene revertir: si el lote hubiera
    // entrado, el alias es idempotente por operación, así que un reintento reusa
    // el mismo identificador ante el banco en vez de crear un segundo débito.
    logger.error('[dispersión] El proveedor rechazó la orden', {
      provider: resolved.provider, purpose, reference, error: err.message,
    });

    if (typeof revert === 'function') {
      try {
        await revert();
      } catch (revertErr) {
        // Esto es lo que deja una operación trabada: reclamada, sin orden en el
        // banco y sin vuelta atrás. No se puede resolver desde acá, pero tiene
        // que quedar ruidoso, porque el único arreglo es a mano.
        logger.error('[dispersión] ⚠️ No se pudo revertir el claim: operación trabada', {
          provider: resolved.provider, purpose, reference,
          errorOriginal: err.message, errorReversion: revertErr.message,
        });
        return fail(
          PAYOUT_ERRORS.PROVIDER_ERROR,
          `Error al dispersar en el banco (${err.message}) y la reversión también falló (${revertErr.message}). La operación quedó trabada y necesita revisión manual.`,
          false,   // ya no es reintentable: el estado quedó inconsistente
        );
      }
    }

    return fail(
      PAYOUT_ERRORS.PROVIDER_ERROR,
      `Error al dispersar en el banco: ${err.message}`,
      true,
    );
  }

  logger.info('[dispersión] Orden aceptada', {
    provider:    resolved.provider,
    purpose,
    reference,
    bankBatchId: result.bankBatchId,
    mock:        !!result._mock,
  });

  return {
    ok:          true,
    provider:    resolved.provider,
    bankBatchId: result.bankBatchId,
    reference:   result.reference,
    mock:        !!result._mock,
  };
}
