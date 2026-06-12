/**
 * bankQrRegistry.js — Registro de proveedores de QR bancario boliviano
 *
 * Para agregar un banco nuevo:
 *   1. Crear src/services/bankQr/banks/{banco}QrService.js
 *      implementando: generateQR, cancelQR, getQRStatus, getPaidQRs, isAvailable
 *   2. Importar y registrar aquí con un bankId único (ej. 'bisa', 'bnb', 'union')
 *   3. Configurar las variables de entorno del banco nuevo
 *
 * El bankId se guarda en Transaction.bankQr.bankId para identificar qué banco
 * procesó el pago de esa transacción.
 */

import * as becQrService from './banks/becQrService.js';

/** @type {Map<string, IBankQrService>} */
const REGISTRY = new Map([
  ['bec', becQrService],   // Banco Económico Bolivia
  // ['bisa', bisaQrService],  // Banco Bisa (futuro)
  // ['bnb',  bnbQrService],   // Banco Nacional de Bolivia (futuro)
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
