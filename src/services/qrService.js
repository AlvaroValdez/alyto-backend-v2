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

/**
 * Genera un QR SEP-0007 (Stellar URI scheme) para un pago/retiro hacia una
 * dirección Stellar. Usado por el fondeo de tesorería (H3): codifica la dirección
 * de tesorería + el memo correlativo del intent.
 *
 * ⚠️ El monto se OMITE a propósito: exchanges centralizados (Binance) no ingieren
 * un SEP-7 completo y el monto real se reconcilia on-chain. Incluirlo daría falsa
 * sensación de que el exchange lo respeta. El QR transporta lo irreversible:
 * dirección + memo.
 *
 * @param {object}  params
 * @param {string}  params.destination  — dirección Stellar destino (G...)
 * @param {string} [params.assetCode]   — código del asset (default 'USDC')
 * @param {string}  params.assetIssuer  — issuer del asset (G...)
 * @param {string} [params.memo]        — memo texto (ej. correlativo del intent)
 * @returns {Promise<{ uri: string, qrBase64: string }>}
 */
export async function generateStellarPayQR({ destination, assetCode = 'USDC', assetIssuer, memo }) {
  const params = new URLSearchParams();
  params.set('destination', destination);
  if (assetCode && assetIssuer) {
    params.set('asset_code',   assetCode);
    params.set('asset_issuer', assetIssuer);
  }
  if (memo) {
    params.set('memo',      memo);
    params.set('memo_type', 'MEMO_TEXT');
  }
  const uri = `web+stellar:pay?${params.toString()}`;

  const qrBase64 = await QRCode.toDataURL(uri, {
    width:  300,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });

  return { uri, qrBase64 };
}
