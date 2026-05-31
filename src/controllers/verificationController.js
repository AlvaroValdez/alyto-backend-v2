/**
 * verificationController.js — Verificación pública de comprobantes B2B
 *
 * Endpoint público (sin auth) para verificar la autenticidad de un
 * Comprobante Oficial de Servicio B2B mediante el hash SHA-256 impreso
 * en el QR del documento.
 *
 *   GET /api/v1/verify/:hash
 *     · navegador / escaneo de QR (Accept: text/html) → página HTML de verificación
 *     · cliente API (Accept: application/json o ?format=json) → JSON
 *
 * El hash se genera con SHA-256(invoiceNumber|txid|fechaISO) y está
 * persistido en Transaction.businessInvoice.verificationHash.
 */

import Transaction from '../models/Transaction.js';

// ─── Helpers de presentación ──────────────────────────────────────────────────

const STATUS_LABELS = {
  liquidation_completed: 'Completada',
  completed:             'Completada',
  payout_sent:           'En proceso de pago',
  payout_confirmed:      'Completada',
  payin_confirmed:       'En proceso',
  pending_funding:       'En proceso',
  payin_pending:         'Pendiente de pago',
  failed:                'Fallida',
};

function formatMoney(amount, currency) {
  if (amount == null) return null;
  const n = Number(amount);
  const symbol = currency === 'BOB' ? 'Bs ' : currency === 'USD' ? '$' : '';
  const [int, dec] = n.toFixed(2).split('.');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${symbol}${intFmt},${dec}${currency && !symbol ? ' ' + currency : ''}`;
}

function formatDate(d) {
  if (!d) return null;
  try {
    return new Date(d).toLocaleString('es-BO', {
      timeZone: 'America/La_Paz',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return null; }
}

/** Escapa texto para inyección segura en HTML. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ─── Plantilla HTML ────────────────────────────────────────────────────────────

const NAVY = '#1D3461';
const GOLD = '#F5A623';

function page({ statusCode, icon, iconColor, title, subtitle, rows = [], stellarTxId = null }) {
  const rowsHtml = rows
    .filter(([, v]) => v != null && v !== '')
    .map(([label, value]) => `
      <div class="row">
        <span class="row-label">${esc(label)}</span>
        <span class="row-value">${esc(value)}</span>
      </div>`)
    .join('');

  const stellarBtn = stellarTxId ? `
    <a class="stellar-link" href="https://stellar.expert/explorer/public/tx/${esc(stellarTxId)}" target="_blank" rel="noopener noreferrer">
      Ver trazabilidad en Stellar ↗
    </a>` : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Verificación de comprobante · Alyto</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: #F8FAFC; color: #0F172A; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      background: #fff; border: 1px solid #E2E8F0; border-radius: 24px;
      box-shadow: 0 8px 40px rgba(15,23,42,0.08);
      max-width: 440px; width: 100%; overflow: hidden;
    }
    .topbar { height: 6px; background: ${GOLD}; }
    .inner { padding: 32px 28px 28px; }
    .brand { text-align: center; margin-bottom: 22px; }
    .brand .logo { font-size: 1.6rem; font-weight: 800; color: ${NAVY}; letter-spacing: -0.02em; }
    .brand .logo .dot { color: ${GOLD}; }
    .brand .sub { font-size: 0.72rem; color: #64748B; margin-top: 2px; letter-spacing: 0.04em; }
    .status { text-align: center; margin-bottom: 24px; }
    .status .icon {
      width: 64px; height: 64px; border-radius: 50%; margin: 0 auto 14px;
      display: flex; align-items: center; justify-content: center; font-size: 34px;
    }
    .status h1 { font-size: 1.2rem; font-weight: 800; }
    .status p  { font-size: 0.875rem; color: #64748B; margin-top: 6px; line-height: 1.45; }
    .rows { border-top: 1px solid #E2E8F0; }
    .row { display: flex; justify-content: space-between; align-items: baseline;
           padding: 12px 0; border-bottom: 1px solid #F1F5F9; gap: 16px; }
    .row-label { font-size: 0.75rem; color: #64748B; flex-shrink: 0; }
    .row-value { font-size: 0.875rem; font-weight: 600; color: #0F172A; text-align: right; word-break: break-word; }
    .stellar-link {
      display: block; text-align: center; margin-top: 22px; padding: 13px;
      background: ${NAVY}; color: #fff; text-decoration: none;
      border-radius: 14px; font-size: 0.875rem; font-weight: 700;
    }
    .legal { margin-top: 20px; font-size: 0.66rem; color: #94A3B8; text-align: center; line-height: 1.5; }
  </style>
</head>
<body>
  <main class="card">
    <div class="topbar"></div>
    <div class="inner">
      <div class="brand">
        <div class="logo">aly<span class="dot">›</span>to</div>
        <div class="sub">AV FINANCE SRL · COMPROBANTE OFICIAL</div>
      </div>
      <div class="status">
        <div class="icon" style="background:${iconColor}1A; color:${iconColor};">${icon}</div>
        <h1 style="color:${iconColor};">${esc(title)}</h1>
        <p>${esc(subtitle)}</p>
      </div>
      ${rowsHtml ? `<div class="rows">${rowsHtml}</div>` : ''}
      ${stellarBtn}
      <p class="legal">
        Verificación pública emitida por AV Finance SRL (producto Alyto).
        La trazabilidad blockchain en Stellar Network es pública e inmutable.
      </p>
    </div>
  </main>
</body>
</html>`;
}

// ─── Controlador ────────────────────────────────────────────────────────────────

export async function verifyInvoice(req, res) {
  const { hash } = req.params;
  // Negociación: HTML por defecto (escaneo de QR abre navegador); JSON si lo piden.
  const wantsJson = req.query.format === 'json' || req.accepts(['html', 'json']) === 'json';

  const respond = (statusCode, json, html) => {
    if (wantsJson) return res.status(statusCode).json(json);
    return res.status(statusCode).type('html').send(html);
  };

  // ── Validación del hash ────────────────────────────────────────────────────
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
    return respond(
      400,
      { valid: false, error: 'Hash de verificación inválido.' },
      page({
        statusCode: 400, icon: '!', iconColor: '#F59E0B',
        title: 'Enlace inválido',
        subtitle: 'El código de verificación no tiene el formato esperado. Verifica que escaneaste el QR completo.',
      }),
    );
  }

  try {
    const tx = await Transaction.findOne({ 'businessInvoice.verificationHash': hash })
      .select([
        'businessInvoice.invoiceNumber',
        'businessInvoice.invoiceGeneratedAt',
        'originalAmount', 'originCurrency',
        'destinationAmount', 'destinationCurrency',
        'stellarTxId', 'legalEntity', 'status', 'createdAt',
      ].join(' '))
      .lean();

    if (!tx) {
      return respond(
        404,
        { valid: false, error: 'Comprobante no encontrado. El hash no corresponde a ningún documento emitido.' },
        page({
          statusCode: 404, icon: '✕', iconColor: '#EF4444',
          title: 'Comprobante no encontrado',
          subtitle: 'Este código no corresponde a ningún comprobante emitido por AV Finance SRL. Podría ser una falsificación o un documento aún no registrado.',
        }),
      );
    }

    const inv = tx.businessInvoice ?? {};
    const jsonBody = {
      valid:           true,
      invoiceNumber:   inv.invoiceNumber,
      transactionDate: tx.createdAt,
      issuedAt:        inv.invoiceGeneratedAt,
      amount:          tx.originalAmount,
      currency:        tx.originCurrency,
      legalEntity:     tx.legalEntity,
      status:          tx.status,
      emitter:         'AV Finance SRL',
      product:         'Alyto',
    };

    return respond(
      200,
      jsonBody,
      page({
        statusCode: 200, icon: '✓', iconColor: '#16A34A',
        title: 'Comprobante verificado',
        subtitle: 'Este documento fue emitido legítimamente por AV Finance SRL y su operación está registrada en la red Stellar.',
        rows: [
          ['N° de comprobante', inv.invoiceNumber],
          ['Emitido',           formatDate(inv.invoiceGeneratedAt ?? tx.createdAt)],
          ['Monto origen',      formatMoney(tx.originalAmount, tx.originCurrency)],
          ['Monto destino',     formatMoney(tx.destinationAmount, tx.destinationCurrency)],
          ['Estado',            STATUS_LABELS[tx.status] ?? tx.status],
          ['Entidad emisora',   `AV Finance ${tx.legalEntity ?? 'SRL'} · Alyto`],
        ],
        stellarTxId: tx.stellarTxId ?? null,
      }),
    );
  } catch (err) {
    console.error('[Verification] Error verificando comprobante:', err.message);
    return respond(
      500,
      { valid: false, error: 'Error interno al verificar el comprobante.' },
      page({
        statusCode: 500, icon: '!', iconColor: '#EF4444',
        title: 'Error de verificación',
        subtitle: 'No pudimos verificar el comprobante en este momento. Intenta nuevamente en unos minutos.',
      }),
    );
  }
}
