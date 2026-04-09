/**
 * businessInvoiceController.js — Controller de Factura B2B
 *
 * Maneja la generación y descarga del Comprobante Oficial de Servicio
 * para clientes Business (accountType === 'business', KYB aprobado)
 * de AV Finance SRL.
 *
 * Funciones:
 *   - generateBusinessInvoiceForTransaction — GET /payments/:transactionId/business-invoice
 *   - adminGetBusinessInvoice               — GET /admin/transactions/:transactionId/business-invoice
 *   - autoGenerateBusinessInvoice           — Interna, fire-and-forget
 *
 * SKILL activo: Compliance_Bolivia_Alyto
 * COMPLIANCE: Terminología prohibida ausente.
 */

import Transaction     from '../models/Transaction.js';
import User            from '../models/User.js';
import BusinessProfile from '../models/BusinessProfile.js';
import { generateBusinessInvoice } from '../utils/businessInvoiceGenerator.js';
import { generarNumeroCorrelativo } from '../utils/correlativoService.js';

// ── Helper: construir DTO desde transacción + perfil business ───────────────

/**
 * Construye el BusinessInvoiceDTO a partir de la transacción y el perfil B2B.
 *
 * @param {object} transaction  — Documento Transaction (lean o mongoose)
 * @param {object} profile      — Documento BusinessProfile (lean)
 * @param {string} invoiceNumber — Número correlativo generado
 * @returns {object} DTO listo para generateBusinessInvoice()
 */
function buildInvoiceDTO(transaction, profile, invoiceNumber) {
  const comisionServicio = transaction.feeBreakdown?.alytoFee ?? 0;
  const tipoCambio       = transaction.exchangeRate ?? 6.98;
  const totalLiquidado   = transaction.originalAmount - comisionServicio;

  const repLegal = profile.legalRepresentative;
  const representanteLegal = repLegal
    ? `${repLegal.firstName ?? ''} ${repLegal.lastName ?? ''}`.trim() || null
    : null;

  return {
    invoiceNumber,
    razonSocial:         profile.legalName ?? profile.tradeName ?? '—',
    taxId:               profile.taxId ?? '—',
    businessId:          profile.businessId,
    representanteLegal,
    direccionCliente:    profile.address
      ? `${profile.address}${profile.city ? ', ' + profile.city : ''}`
      : null,
    tipoOperacion:       transaction.operationType === 'cross_border'
      ? 'Cross-Border Payment'
      : 'Liquidación de Activo Digital',
    descripcionServicio: transaction.businessInvoice?.serviceDescription ?? null,
    fechaHora:           transaction.createdAt.toISOString(),
    txid:                transaction.stellarTxId ?? 'PENDIENTE',
    montoOrigenBOB:      transaction.originalAmount,
    tipoDeCambio:        tipoCambio,
    fuenteTipoCambio:    transaction.businessInvoice?.exchangeRateSource ?? null,
    montoActivoDigital:  transaction.digitalAssetAmount ?? (transaction.originalAmount / tipoCambio),
    comisionServicio,
    spreadFx:            transaction.businessInvoice?.spreadFx ?? null,
    totalLiquidado,
    bancarizacion:       transaction.businessInvoice?.bancarizacion ?? null,
  };
}

// ── Helper: buscar transacción y validar condiciones comunes ────────────────

/**
 * Busca la transacción por alytoTransactionId y valida:
 *   - Existe
 *   - Status === 'completed'
 *   - legalEntity === 'SRL'
 *
 * @param {string} transactionId — alytoTransactionId
 * @param {import('express').Response} res
 * @returns {Promise<object|null>} transacción o null (ya respondió con error)
 */
async function findAndValidateTransaction(transactionId, res) {
  let transaction;
  try {
    transaction = await Transaction.findOne({ alytoTransactionId: transactionId });
  } catch (err) {
    console.error('[B2B Invoice] Error buscando transacción:', err.message);
    res.status(500).json({ success: false, error: 'Error interno del servidor.' });
    return null;
  }

  if (!transaction) {
    res.status(404).json({ success: false, error: 'Transacción no encontrada.' });
    return null;
  }

  if (transaction.status !== 'completed') {
    res.status(409).json({
      success:        false,
      error:          'La factura B2B solo está disponible para transacciones completadas.',
      currentStatus:  transaction.status,
      requiredStatus: 'completed',
    });
    return null;
  }

  if (transaction.legalEntity !== 'SRL') {
    res.status(403).json({
      success:        false,
      error:          'La factura B2B solo está disponible para operaciones de la jurisdicción SRL.',
      currentEntity:  transaction.legalEntity,
      requiredEntity: 'SRL',
    });
    return null;
  }

  return transaction;
}

// ── Helper: generar y enviar PDF ────────────────────────────────────────────

/**
 * Genera el PDF B2B y lo envía como response.
 *
 * @param {object} transaction
 * @param {import('express').Response} res
 */
async function generateAndStreamPDF(transaction, res) {
  // Cargar usuario para verificar accountType
  const user = await User.findById(transaction.userId).lean();
  if (!user || user.accountType !== 'business' || !user.businessProfileId) {
    return res.status(403).json({
      success: false,
      error:   'Esta transacción no pertenece a un cliente Business con KYB aprobado.',
    });
  }

  // Cargar perfil business
  const profile = await BusinessProfile.findById(user.businessProfileId).lean();
  if (!profile) {
    return res.status(404).json({
      success: false,
      error:   'Perfil Business no encontrado para este usuario.',
    });
  }

  // Generar número correlativo si no existe
  const invoiceNumber = transaction.businessInvoice?.invoiceNumber
    ?? generarNumeroCorrelativo('SRV', transaction);

  // Construir DTO y generar PDF
  const dto = buildInvoiceDTO(transaction, profile, invoiceNumber);
  const { buffer, filename, verificationHash } = await generateBusinessInvoice(dto);

  // Persistir referencia en BD (si no existe aún)
  if (!transaction.businessInvoice?.invoiceNumber) {
    try {
      await Transaction.findByIdAndUpdate(transaction._id, {
        $set: {
          'businessInvoice.invoiceNumber':      invoiceNumber,
          'businessInvoice.invoiceGeneratedAt':  new Date(),
          'businessInvoice.invoicePdfUrl':       `local://${filename}`,
          'businessInvoice.verificationHash':    verificationHash,
        },
      });
    } catch (err) {
      // No crítico — el PDF ya fue generado
      console.warn('[B2B Invoice] No se pudo persistir referencia en BD:', err.message);
    }
  }

  // Stream PDF
  res.setHeader('Content-Type',        'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length',      buffer.length);
  return res.status(200).send(buffer);
}

// ─── GET /api/v1/payments/:transactionId/business-invoice ───────────────────

/**
 * Genera y descarga la factura B2B para el usuario autenticado.
 * Requiere: protect + checkBusinessKYB
 *
 * Valida ownership: transaction.userId debe coincidir con req.user._id.
 */
export async function generateBusinessInvoiceForTransaction(req, res) {
  const { transactionId } = req.params;

  const transaction = await findAndValidateTransaction(transactionId, res);
  if (!transaction) return;

  // Verificar ownership — el usuario solo puede descargar sus propias facturas
  if (transaction.userId.toString() !== req.user._id.toString()) {
    return res.status(404).json({
      success: false,
      error:   'Transacción no encontrada.',
    });
  }

  try {
    return await generateAndStreamPDF(transaction, res);
  } catch (err) {
    console.error('[B2B Invoice] Error generando factura para usuario:', {
      transactionId,
      userId: req.user._id,
      error:  err.message,
    });
    return res.status(500).json({
      success: false,
      error:   'Error al generar la factura B2B. Intenta nuevamente.',
    });
  }
}

// ─── GET /api/v1/admin/transactions/:transactionId/business-invoice ─────────

/**
 * Genera y descarga la factura B2B desde el panel admin.
 * Sin ownership check — el admin puede descargar cualquier factura.
 * Auth ya asegurado por router.use(protect, checkAdmin) en adminRoutes.
 */
export async function adminGetBusinessInvoice(req, res) {
  const { transactionId } = req.params;

  const transaction = await findAndValidateTransaction(transactionId, res);
  if (!transaction) return;

  try {
    return await generateAndStreamPDF(transaction, res);
  } catch (err) {
    console.error('[B2B Invoice] Error generando factura (admin):', {
      transactionId,
      adminId: req.user._id,
      error:   err.message,
    });
    return res.status(500).json({
      success: false,
      error:   'Error al generar la factura B2B.',
    });
  }
}

// ─── Función interna: auto-generación fire-and-forget ───────────────────────

/**
 * Genera automáticamente la factura B2B tras completar una liquidación Bolivia.
 * Diseñada para ser llamada fire-and-forget (sin await en el caller).
 *
 * @param {object} transaction — Documento Transaction (mongoose, no lean)
 * @param {string} userId      — ObjectId del usuario
 */
export async function autoGenerateBusinessInvoice(transaction, userId) {
  try {
    const user = await User.findById(userId).lean();
    if (!user?.businessProfileId) return;

    const profile = await BusinessProfile.findById(user.businessProfileId).lean();
    if (!profile) return;

    const invoiceNumber = generarNumeroCorrelativo('SRV', transaction);
    const dto = buildInvoiceDTO(transaction, profile, invoiceNumber);
    const { filename, verificationHash } = await generateBusinessInvoice(dto);

    await Transaction.findByIdAndUpdate(transaction._id, {
      $set: {
        'businessInvoice.invoiceNumber':      invoiceNumber,
        'businessInvoice.invoiceGeneratedAt':  new Date(),
        'businessInvoice.invoicePdfUrl':       `local://${filename}`,
        'businessInvoice.verificationHash':    verificationHash,
      },
    });

    console.info('[B2B Invoice] Factura auto-generada:', {
      transactionId:  transaction.alytoTransactionId,
      invoiceNumber,
      businessId:     profile.businessId,
    });
  } catch (err) {
    console.warn('[B2B Invoice] Auto-generación falló (no crítico):', {
      transactionId: transaction?.alytoTransactionId,
      error:         err.message,
    });
  }
}
