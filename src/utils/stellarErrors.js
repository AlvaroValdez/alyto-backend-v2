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
    // Error de Horizon con response body
    const horizonData = error.response.data;
    console.error(`[Alyto Stellar][${context}] Horizon error`, {
      status:    error.response?.status,
      type:      horizonData?.type,
      title:     horizonData?.title,
      detail:    horizonData?.detail,
      resultXdr: horizonData?.extras?.result_xdr ?? null,
      ...safeMetadata,
    });
  } else if (error instanceof Error) {
    console.error(`[Alyto Stellar][${context}] Error: ${error.message}`, safeMetadata);
  } else {
    console.error(`[Alyto Stellar][${context}] Error desconocido`, safeMetadata);
  }
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
