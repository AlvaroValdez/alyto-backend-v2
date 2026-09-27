/**
 * bankQrRegistry.js — Registro de proveedores de QR bancario boliviano
 *
 * Para agregar un banco nuevo:
 *   1. Crear src/services/bankQr/banks/{banco}QrService.js
 *      implementando: generateQR, cancelQR, getQRStatus, getPaidQRs, isAvailable
 *      y (recomendado) verifyIpn(req) → autentica el IPN entrante antes de acreditar.
 *      Si un banco no implementa verifyIpn, el handler de IPN debe rechazar por
 *      seguridad (no acreditar sin verificación).
 *      Opcional: normalizeIpn(req) → traduce el body del webhook a la forma
 *      `{ qrId, amount, ... }`. Solo hace falta si el banco NO manda el payload
 *      anidado bajo `payment` (la forma de BANECO, que el handler asume por
 *      defecto). Red Enlace manda un objeto plano y por eso la implementa.
 *   2. Importar y registrar aquí con un bankId único (ej. 'bnb', 'union')
 *   3. Configurar las variables de entorno del banco nuevo
 *
 * El bankId se guarda en Transaction.bankQr.bankId para identificar qué banco
 * procesó el pago de esa transacción.
 */

import * as becQrService       from './banks/becQrService.js';
import * as redenlaceQrService from './banks/redenlaceQrService.js';

/** @type {Map<string, IBankQrService>} */
const REGISTRY = new Map([
  ['bec',       becQrService],        // Banco Económico Bolivia
  ['redenlace', redenlaceQrService],  // ATC S.A. — Red Enlace (QR Simple)
  // ['bnb', bnbQrService],  // Banco Nacional de Bolivia (futuro)
]);

/**
 * Obtiene el servicio QR de un banco por su ID.
 * @param {string} bankId
 * @returns {IBankQrService}
 * @throws si el bankId no está registrado
 */
export function getBankQrService(bankId) {
  const svc = REGISTRY.get(bankId);
  if (!svc) throw new Error(`Bank QR provider no registrado: '${bankId}'. IDs disponibles: ${listBankIds().join(', ')}`);
  return svc;
}

/** @returns {string[]} IDs de todos los bancos registrados */
export function listBankIds() {
  return [...REGISTRY.keys()];
}

/** @returns {string[]} IDs de bancos con credenciales configuradas */
export function listAvailableBankIds() {
  return listBankIds().filter(id => REGISTRY.get(id).isAvailable());
}
