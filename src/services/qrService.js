/**
 * qrService.js — Generador de códigos QR para pagos manuales Bolivia (SRL)
 *
 * El QR codifica los datos de transferencia bancaria en formato JSON estándar.
 * Se devuelve como base64 data URL (image/png) para incrustar directamente en
 * emails o respuestas API sin requerir almacenamiento adicional.
 *
 * Uso:
 *   import { generatePaymentQR } from '../services/qrService.js'
 *   const { qrBase64, qrData } = await generatePaymentQR(transaction)
 */

import QRCode from 'qrcode';

/**
 * Genera un código QR con los datos de transferencia bancaria de AV Finance SRL.
 *
 * @param {object} transaction — Documento Transaction de Mongoose (o plain object)
 * @param {number} transaction.originalAmount   — Monto en BOB
 * @param {string} transaction.alytoTransactionId — ID de referencia
 * @returns {Promise<{ qrBase64: string, qrData: object }>}
 */
export async function generatePaymentQR(transaction) {
  const qrData = {
    banco:      process.env.SRL_BANK_NAME      ?? 'Banco Bisa',
    titular:    process.env.SRL_ACCOUNT_HOLDER ?? 'AV Finance SRL',
    cuenta:     process.env.SRL_ACCOUNT_NUMBER ?? '',
    tipo:       process.env.SRL_ACCOUNT_TYPE   ?? 'Cuenta Corriente',
    moneda:     'BOB',
    monto:      transaction.originalAmount,
    referencia: transaction.alytoTransactionId,
    concepto:   `Alyto - ${transaction.alytoTransactionId}`,
  };

  const qrBase64 = await QRCode.toDataURL(JSON.stringify(qrData), {
    width:  300,
    margin: 2,
    color: {
      dark:  '#000000',
      light: '#ffffff',
    },
  });

  return { qrBase64, qrData };
}
