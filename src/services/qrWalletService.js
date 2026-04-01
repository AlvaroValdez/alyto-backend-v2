/**
 * qrWalletService.js — QR Alyto firmados HMAC-SHA256
 *
 * Tres tipos de QR:
 *   'charge'  — comercio/persona cobra monto fijo (expira 10 min)
 *   'p2p'     — usuario paga monto específico a otro (expira 5 min)
 *   'deposit' — QR permanente de depósito sin monto fijo (sin expiración)
 *
 * El QR codifica un JSON firmado con HMAC-SHA256.
 * La firma se valida en verifyQR() antes de cualquier operación financiera.
 */

import crypto from 'crypto';
import QRCode  from 'qrcode';

const QR_SECRET = process.env.QR_HMAC_SECRET ?? process.env.JWT_SECRET;

// TTL por defecto en segundos por tipo
const DEFAULT_TTL = { charge: 600, p2p: 300, deposit: 0 };

/**
 * Genera un QR Alyto firmado HMAC-SHA256.
 *
 * @param {object} params
 * @param {'charge'|'p2p'|'deposit'} params.type
 * @param {string}  params.creatorUserId
 * @param {string}  params.creatorName
 * @param {number}  [params.amount]        — requerido para charge/p2p
 * @param {string}  [params.description]
 * @param {number}  [params.expiresInSecs] — override del TTL por defecto
 * @returns {Promise<{ qrId, qrBase64, payload, expiresAt }>}
 */
export async function generateQR({
  type,
  creatorUserId,
  creatorName,
  amount,
  description,
  expiresInSecs,
}) {
  if (!['charge', 'p2p', 'deposit'].includes(type)) {
    throw new Error('Tipo de QR inválido. Usa: charge, p2p o deposit.');
  }
  if ((type === 'charge' || type === 'p2p') && (!amount || Number(amount) < 1)) {
    throw new Error('Los tipos charge y p2p requieren amount >= 1 BOB.');
  }

  const ttl  = expiresInSecs != null ? Number(expiresInSecs) : DEFAULT_TTL[type];
  const now  = Date.now();
  const qrId = `QR-${type.toUpperCase()}-${now}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  const payload = {
    v:           1,
    qrId,
    type,
    creatorUserId,
    creatorName,
    amount:      amount != null ? Number(amount) : null,
    description: description ?? null,
    createdAt:   now,
    expiresAt:   ttl > 0 ? now + ttl * 1000 : null,
  };

  // Firma HMAC-SHA256 sobre el payload sin `sig`
  const dataToSign = JSON.stringify(payload);
  const signature  = crypto
    .createHmac('sha256', QR_SECRET)
    .update(dataToSign)
    .digest('hex');

  payload.sig = signature;

  const qrBase64 = await QRCode.toDataURL(JSON.stringify(payload), {
    width:                400,
    margin:               2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });

  return {
    qrId,
    qrBase64,
    payload,
    expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
  };
}

/**
 * Verifica y parsea un QR Alyto escaneado.
 * Valida firma HMAC-SHA256 y expiración.
 *
 * @param {string} rawQrContent — string leído del QR (JSON serializado)
 * @returns {{ valid: boolean, payload?: object, error?: string }}
 */
export function verifyQR(rawQrContent) {
  let payload;
  try {
    payload = JSON.parse(rawQrContent);
  } catch {
    return { valid: false, error: 'QR inválido — no es JSON válido.' };
  }

  const { sig, ...dataWithoutSig } = payload;
  if (!sig) return { valid: false, error: 'QR sin firma HMAC.' };

  // Verificar firma en tiempo constante (previene timing attacks)
  const expected = crypto
    .createHmac('sha256', QR_SECRET)
    .update(JSON.stringify(dataWithoutSig))
    .digest('hex');

  let isValid = false;
  try {
    isValid = crypto.timingSafeEqual(
      Buffer.from(sig,      'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    // Buffer de distinto tamaño → firma claramente inválida
    return { valid: false, error: 'Firma QR inválida.' };
  }

  if (!isValid) return { valid: false, error: 'Firma QR inválida.' };

  // Verificar expiración
  if (payload.expiresAt && Date.now() > payload.expiresAt) {
    return { valid: false, error: 'QR expirado.' };
  }

  return { valid: true, payload };
}
