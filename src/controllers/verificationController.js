/**
 * verificationController.js — Verificación pública de comprobantes
 *
 * Endpoint público (sin auth) para verificar la autenticidad de un
 * Comprobante Oficial de Servicio B2B mediante el hash SHA-256
 * impreso en el QR del documento.
 *
 * GET /api/v1/verify/:hash
 *   → { valid, invoiceNumber, transactionDate, amount, legalEntity }
 */

import Transaction from '../models/Transaction.js';

/**
 * Verifica un comprobante B2B por su hash de verificación.
 *
 * El hash se genera con SHA-256(invoiceNumber|txid|fechaISO) y está
 * impreso en el QR del PDF. Cualquiera puede escanear y verificar.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function verifyInvoice(req, res) {
  const { hash } = req.params;

  if (!hash || hash.length !== 64) {
    return res.status(400).json({
      valid: false,
      error: 'Hash de verificación inválido.',
    });
  }

  try {
    const transaction = await Transaction.findOne({
      'businessInvoice.verificationHash': hash,
    })
      .select('businessInvoice.invoiceNumber businessInvoice.invoiceGeneratedAt originalAmount originCurrency legalEntity status createdAt')
      .lean();

    if (!transaction) {
      return res.status(404).json({
        valid: false,
        error: 'Comprobante no encontrado. El hash no corresponde a ningún documento emitido.',
      });
    }

    return res.status(200).json({
      valid:           true,
      invoiceNumber:   transaction.businessInvoice.invoiceNumber,
      transactionDate: transaction.createdAt,
      issuedAt:        transaction.businessInvoice.invoiceGeneratedAt,
      amount:          transaction.originalAmount,
      currency:        transaction.originCurrency,
      legalEntity:     transaction.legalEntity,
      status:          transaction.status,
      emitter:         'AV Finance SRL',
      product:         'Alyto',
    });
  } catch (err) {
    console.error('[Verification] Error verificando comprobante:', err.message);
    return res.status(500).json({
      valid: false,
      error: 'Error interno al verificar el comprobante.',
    });
  }
}
