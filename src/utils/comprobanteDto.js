/**
 * comprobanteDto.js — Fuente única del DTO del Comprobante Oficial de
 * Transacción (retail SRL Bolivia).
 *
 * El mismo documento se emite desde TRES lugares:
 *   1. `ipnController.generateSrlComprobante`  — al completarse la transacción
 *   2. `payoutController.processBoliviaManualPayout` — liquidación manual
 *   3. `POST /admin/regenerate-comprobante`    — reemisión bajo demanda
 *
 * Cada uno construía su propio DTO y habían divergido. Consecuencias reales
 * detectadas el 2026-08-15:
 *   - (2) y (3) leían la comisión de `feeBreakdown.alytoFee`, un sub-esquema
 *     LEGACY que ningún path escribe → comisión 0 y `totalLiquidado` inflado.
 *     El campo canónico es `fees.totalDeducted` (lo escribe quoteCalculator vía
 *     paymentController).
 *   - (3) imprimía 'NO REGISTRADO' cuando el CI no estaba capturado, en vez del
 *     'En verificación' que fija `resolveClientDocument` (ver clientDocument.js).
 *   - (3) recalculaba el tipo de cambio en vez de reproducir el estampado.
 *
 * Como el correlativo se reutiliza y la key de S3 es determinista, dos
 * emisiones divergentes dejaban DOS versiones inmutables (Object Lock
 * COMPLIANCE 1825d) del mismo Comprobante N con distinta comisión y distinto
 * total liquidado. De ahí que el DTO tenga que salir de un solo lugar.
 */

import { resolveClientDocument } from './clientDocument.js';

/**
 * Comisión de servicio que se imprime en el comprobante.
 * `fees.totalDeducted` es el campo canónico; `feeBreakdown` queda como fallback
 * para registros legacy.
 *
 * @param {object} transaction
 * @returns {number}
 */
export function resolveComisionServicio(transaction) {
  return transaction?.fees?.totalDeducted
    ?? transaction?.feeBreakdown?.alytoFee
    ?? 0;
}

/**
 * Tipo de cambio BOB/USDC que se imprime.
 *
 * Precedencia (de más autoritativo a menos):
 *   1. `override` — la tasa ya resuelta por quien liquida (payoutController,
 *      que la valida contra la banda permitida)
 *   2. `boliviaCompliance.exchangeRateBob` — la que quedó estampada al liquidar
 *   3. `conversionRate.rate` — la bloqueada al despachar el payout
 *   4. derivada del neto (excluye fees, para no inflar la tasa mostrada)
 *
 * @param {object} transaction
 * @param {number} [override]
 * @returns {number}
 */
export function resolveTipoCambioComprobante(transaction, override) {
  if (Number.isFinite(override) && override > 0) return override;

  const estampado = transaction?.boliviaCompliance?.exchangeRateBob;
  if (Number.isFinite(estampado) && estampado > 0) return estampado;

  const bloqueado = transaction?.conversionRate?.rate;
  if (Number.isFinite(bloqueado) && bloqueado > 0) return bloqueado;

  const digital = transaction?.digitalAssetAmount ?? 0;
  const netBOB  = (transaction?.originalAmount ?? 0)
    - (transaction?.fees?.totalDeducted   ?? 0)
    - (transaction?.fees?.profitRetention ?? 0);

  return digital > 0 && netBOB > 0 ? Number((netBOB / digital).toFixed(6)) : 0;
}

/**
 * Construye el DTO completo que consume `generateOfficialReceipt`.
 *
 * @param {object} p
 * @param {object} p.transaction          — documento Transaction (lean o no)
 * @param {object} p.user                 — User con el CI ya descifrable (ensureDek previo)
 * @param {string} p.numeroComprobante    — correlativo BOL-YYYYMM-NNNNNN
 * @param {number} [p.tipoCambioOverride] — tasa ya resuelta por el caller
 * @returns {{ dto: object, clientDoc: object }}
 */
export function buildSrlComprobanteDTO({ transaction, user, numeroComprobante, tipoCambioOverride }) {
  const clientDoc        = resolveClientDocument(user);
  const comisionServicio = resolveComisionServicio(transaction);
  const tipoCambio       = resolveTipoCambioComprobante(transaction, tipoCambioOverride);
  const digital          = transaction.digitalAssetAmount
    ?? (tipoCambio > 0 ? transaction.originalAmount / tipoCambio : 0);

  const dto = {
    // Sección 1 — Cabecera
    numeroComprobante,

    // Sección 2 — KYC
    nombreCliente:      user.companyName ?? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim(),
    nitOci:             clientDoc.nitOci,
    tipoDocumento:      clientDoc.tipoDocumento,
    codigoClienteAlyto: user._id.toString(),

    // Sección 3 — Trazabilidad Web3
    fechaHora:     (transaction.createdAt ?? new Date()).toISOString(),
    tipoOperacion: 'Liquidación de Activo Digital',          // Terminología corporativa
    txid:          transaction.stellarTxId ?? 'PENDIENTE',

    // Sección 4 — Desglose financiero (en BOB)
    montoFiatRecibido:    transaction.originalAmount,
    tipoDeCambio:         tipoCambio,
    montoActivoEntregado: digital,
    comisionServicio,
    totalLiquidado:       transaction.originalAmount - comisionServicio,

    // Sección 5 — Footer legal: lo pone pdfGenerator desde AV_FINANCE_LEGAL_FOOTER
  };

  return { dto, clientDoc };
}
