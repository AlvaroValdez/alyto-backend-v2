/**
 * payoutController.js — Controlador de Off-Ramp y Liquidación
 *
 * Maneja el endpoint de liquidación manual del Corredor Bolivia (Escenario C).
 * Valida que la operación corresponda a AV Finance SRL antes de proceder.
 *
 * Flujo de processBoliviaManualPayout:
 *   1. Buscar la transacción en BD y verificar estado 'in_transit'
 *   2. Validación Multi-Entidad → legalEntity = 'SRL' (jurisdicción Bolivia)
 *   3. Marcar la transacción como 'completed'
 *   4. Generar el Comprobante Oficial de Transacción (PDF)
 *   5. Persistir referencia del comprobante en BD
 *   6. Retornar el PDF al operador o al cliente
 *
 * SKILL activo: Compliance_Bolivia_Alyto
 * COMPLIANCE: Terminología prohibida ausente.
 */

import Transaction from '../models/Transaction.js';
import User        from '../models/User.js';
import { generateOfficialReceipt } from '../utils/pdfGenerator.js';
import { generarNumeroCorrelativo } from '../utils/correlativoService.js';
import { autoGenerateBusinessInvoice } from './businessInvoiceController.js';

// ─── POST /api/v1/payouts/bolivia/manual ────────────────────────────────────

/**
 * Procesa la liquidación manual del Corredor Bolivia (AV Finance SRL — Escenario C).
 *
 * Body esperado:
 * {
 *   "transactionId": "64abc...",    ← _id de Transaction en BD
 *   "tipoCambioManual": 6.98        ← Tipo de cambio BOB/USDC aplicado por el operador
 *                                      (opcional, por defecto usa tipoDeCambio simulado)
 * }
 *
 * Respuesta exitosa (200):
 *   → Content-Type: application/pdf
 *   → Attachment: comprobante_BOL-202503-XXXXXX_20250316.pdf
 *
 * Respuesta de error:
 *   → Content-Type: application/json
 *   → { success: false, error: '...' }
 */
export async function processBoliviaManualPayout(req, res) {
  const { transactionId, tipoCambioManual } = req.body;

  // ── 1. Validación de entrada ──────────────────────────────────────────────
  if (!transactionId) {
    return res.status(400).json({
      success: false,
      error:   'El campo transactionId es requerido.',
    });
  }

  // ── 2. Buscar la transacción en BD ────────────────────────────────────────
  let transaction;
  try {
    transaction = await Transaction.findById(transactionId);
  } catch {
    return res.status(400).json({
      success: false,
      error:   'transactionId inválido o con formato incorrecto.',
    });
  }

  if (!transaction) {
    return res.status(404).json({
      success: false,
      error:   'Transacción no encontrada.',
    });
  }

  // ── 3. Verificar estado previo: debe ser 'in_transit' ─────────────────────
  // El tránsito Stellar debe haberse completado antes de ejecutar el off-ramp manual.
  if (transaction.status !== 'in_transit') {
    return res.status(409).json({
      success:         false,
      error:           `La transacción no está en estado 'in_transit'. Estado actual: '${transaction.status}'.`,
      currentStatus:   transaction.status,
      requiredStatus:  'in_transit',
    });
  }

  // ── 4. VALIDACIÓN MULTI-ENTIDAD ───────────────────────────────────────────
  // El Corredor Bolivia opera exclusivamente bajo AV Finance SRL.
  // Transacciones de LLC o SpA no pueden liquidarse por este endpoint.
  if (transaction.legalEntity !== 'SRL') {
    return res.status(403).json({
      success:        false,
      error:          'La liquidación manual Bolivia solo está disponible para operaciones de la jurisdicción SRL.',
      currentEntity:  transaction.legalEntity,
      requiredEntity: 'SRL',
    });
  }

  // Doble chequeo: el país de destino debe ser Bolivia
  if (transaction.destinationCountry && transaction.destinationCountry !== 'BO') {
    return res.status(403).json({
      success:            false,
      error:              'El país de destino de esta transacción no corresponde al Corredor Bolivia.',
      destinationCountry: transaction.destinationCountry,
    });
  }

  // ── 5. Cargar usuario para datos KYC del comprobante ─────────────────────
  let user;
  try {
    user = await User.findById(transaction.userId).lean();
  } catch (err) {
    console.error('[Alyto Payout Bolivia] Error cargando usuario:', {
      transactionId,
      error: err.message,
    });
    return res.status(500).json({
      success: false,
      error:   'Error al cargar datos del cliente. Intenta nuevamente.',
    });
  }

  if (!user) {
    return res.status(404).json({
      success: false,
      error:   'Usuario asociado a la transacción no encontrado.',
    });
  }

  // ── 6. Actualizar la transacción a COMPLETED ──────────────────────────────
  const numeroComprobante = generarNumeroCorrelativo('BOL', transaction);
  const ahora             = new Date();

  try {
    await Transaction.findByIdAndUpdate(transactionId, {
      $set: {
        status:      'completed',
        completedAt: ahora,
        'boliviaCompliance.comprobanteGeneratedAt': ahora,
        'boliviaCompliance.clientTaxId':            user.taxId ?? user.identityDocument?.number,
        'boliviaCompliance.amountBob':              transaction.originalAmount,
        'boliviaCompliance.exchangeRateBob':        tipoCambioManual ?? transaction.exchangeRate ?? 6.98,
      },
      $push: {
        providersUsed: 'payout:anchorBolivia',
        paymentLegs: {
          stage:       'payout',
          provider:    'anchorBolivia',
          status:      'completed',
          completedAt: ahora,
        },
      },
    });
  } catch (err) {
    console.error('[Alyto Payout Bolivia] Error actualizando transacción a completed:', {
      transactionId,
      error: err.message,
    });
    return res.status(500).json({
      success: false,
      error:   'Error al actualizar el estado de la transacción.',
    });
  }

  // ── 7. Generar el Comprobante Oficial de Transacción (PDF) ────────────────
  // Construimos el DTO completo con todos los datos exigidos por Compliance_Bolivia_Alyto
  const tipoCambio        = tipoCambioManual ?? transaction.exchangeRate ?? 6.98;
  const comisionServicio  = transaction.feeBreakdown?.alytoFee ?? 0;
  const totalLiquidado    = transaction.originalAmount - comisionServicio;

  const comprobanteDTO = {
    // Sección 1 — Cabecera
    numeroComprobante,

    // Sección 2 — KYC
    nombreCliente:      user.companyName
                          ?? `${user.firstName} ${user.lastName}`,
    nitOci:             user.taxId ?? user.identityDocument?.number ?? 'NO REGISTRADO',
    tipoDocumento:      user.taxId ? 'NIT' : 'CI',
    codigoClienteAlyto: user._id.toString(),

    // Sección 3 — Trazabilidad Web3 ← campos críticos del TXID
    fechaHora:          transaction.createdAt.toISOString(),
    tipoOperacion:      'Liquidación de Activo Digital',          // Terminología corporativa
    txid:               transaction.stellarTxId ?? 'PENDIENTE',  // Hash Stellar completo

    // Sección 4 — Desglose Financiero (en BOB)
    montoFiatRecibido:     transaction.originalAmount,
    tipoDeCambio:          tipoCambio,
    montoActivoEntregado:  transaction.digitalAssetAmount ?? (transaction.originalAmount / tipoCambio),
    comisionServicio,
    totalLiquidado,

    // Sección 5 — Footer legal (desde .env o placeholder)
    // textoLegalFooter: omitido → pdfGenerator usa AV_FINANCE_LEGAL_FOOTER del entorno
  };

  let pdfBuffer, filename;
  try {
    ({ buffer: pdfBuffer, filename } = await generateOfficialReceipt(comprobanteDTO));
  } catch (err) {
    console.error('[Alyto Payout Bolivia] Error generando Comprobante PDF:', {
      transactionId,
      numeroComprobante,
      error: err.message,
    });
    // La transacción ya está COMPLETED — el PDF puede regenerarse bajo demanda
    return res.status(500).json({
      success:            false,
      error:              'Liquidación registrada, pero el comprobante PDF no pudo generarse. Contactar al equipo operativo.',
      alytoTransactionId: transaction.alytoTransactionId,
      numeroComprobante,
    });
  }

  // ── 8. Persistir referencia del comprobante en BD ─────────────────────────
  // TODO Fase 8: subir el buffer a AWS S3 y guardar la URL real
  // Por ahora se guarda el nombre de archivo para trazabilidad
  try {
    await Transaction.findByIdAndUpdate(transactionId, {
      $set: {
        'boliviaCompliance.comprobantePdfUrl': `local://${filename}`,  // Reemplazar por S3 URL
      },
    });
  } catch (err) {
    // No crítico — el PDF ya fue generado, solo falla la URL en BD
    console.warn('[Alyto Payout Bolivia] No se pudo persistir la URL del comprobante:', {
      transactionId, error: err.message,
    });
  }

  console.info('[Alyto Payout Bolivia] Liquidación completada.', {
    transactionId:      transaction._id.toString(),
    alytoTransactionId: transaction.alytoTransactionId,
    numeroComprobante,
    totalLiquidadoBOB:  totalLiquidado,
    stellarTxId:        transaction.stellarTxId,
  });

  // ── 9. Auto-generar factura B2B si el usuario es Business ─────────────────
  if (user.accountType === 'business' && user.businessProfileId) {
    // Recargar transacción fresca (con status: completed) para el generador B2B
    Transaction.findById(transactionId).then(freshTx => {
      if (freshTx) return autoGenerateBusinessInvoice(freshTx, user._id);
    }).catch(err => console.warn('[B2B Invoice] Auto-generation failed:', err.message));
  }

  // ── 10. Retornar el PDF al caller ─────────────────────────────────────────
  res.setHeader('Content-Type',        'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length',      pdfBuffer.length);
  return res.status(200).send(pdfBuffer);
}
