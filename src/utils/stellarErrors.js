/**
 * stellarErrors.js — Manejo Centralizado de Errores de Red Stellar
 *
 * Principios:
 *  - Loguear el contexto del fallo sin exponer secrets ni rutas internas
 *  - Re-lanzar siempre el error tras loguearlo (no propagación silenciosa)
 *  - Los errores de Horizon son esperables, no excepcionales — no crashear el servidor
 */

// Campos que NUNCA deben aparecer en logs aunque estén en el metadata
const FORBIDDEN_LOG_FIELDS = ['secret', 'privatekey', 'signersecret', 'seed', 'mnemonic', 'keypair'];

/**
 * Manejador centralizado de errores de Stellar/Horizon.
 * Loguea con contexto, sin filtrar datos sensibles accidentalmente.
 *
 * @param {string} context - Nombre del servicio/función donde ocurrió el error
 * @param {unknown} error  - El error capturado
 * @param {Record<string, unknown>} [metadata] - Contexto adicional (public keys, asset codes, etc.)
 */
export function handleStellarError(context, error, metadata = {}) {
  const safeMetadata = sanitizeMetadata(metadata);

  if (error?.response?.data) {
    const horizonData  = error.response.data;
    const resultCodes  = horizonData?.extras?.result_codes ?? {};
    const txCode       = resultCodes.transaction ?? null;
    const opCodes      = resultCodes.operations  ?? [];

    // Adjuntar códigos al error para que Sentry los capture en el mensaje y extras
    if (txCode && !error.stellarTxCode) {
      error.stellarTxCode = txCode;
      error.stellarOpCode = opCodes[0] ?? null;
      error.message = `${error.message} [stellar: tx=${txCode} op=${opCodes[0] ?? 'none'}]`;
    }

    console.error(`[Alyto Stellar][${context}] Horizon error`, {
      httpStatus:  error.response?.status,
      txCode,
      opCodes,
      type:        horizonData?.type,
      title:       horizonData?.title,
      detail:      horizonData?.detail,
      resultXdr:   horizonData?.extras?.result_xdr ?? null,
      ...safeMetadata,
    });
  } else if (error instanceof Error) {
    console.error(`[Alyto Stellar][${context}] Error: ${error.message}`, safeMetadata);
  } else {
    console.error(`[Alyto Stellar][${context}] Error desconocido`, safeMetadata);
  }
}

/**
 * ¿Este error de Horizon significa "la cuenta no existe en el ledger"?
 *
 * Horizon responde 404 tanto para una cuenta que nunca se creó como para una que se
 * quedó sin la reserva mínima de XLM. En el modelo custodial ese estado NO es una
 * anomalía: una cuenta provisionada a medias (publicKey ya en MongoDB, `createAccount`
 * fallido) vive exactamente ahí hasta que alguien la repara.
 *
 * Distinguirlo de un fallo de red es lo importante: tragarse un timeout como si fuera
 * "cuenta vacía" haría que el caller asuma un saldo 0 falso.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAccountNotFound(error) {
  return error?.response?.status === 404 || error?.name === 'NotFoundError';
}

/**
 * Elimina cualquier campo que pudiera contener una llave privada antes de loguear.
 *
 * @param {Record<string, unknown>} metadata
 * @returns {Record<string, unknown>}
 */
function sanitizeMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => !FORBIDDEN_LOG_FIELDS.some(f => key.toLowerCase().includes(f)),
    ),
  );
}
