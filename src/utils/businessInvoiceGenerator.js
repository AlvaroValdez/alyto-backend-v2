/**
 * businessInvoiceGenerator.js — Comprobante Oficial de Servicio B2B
 *
 * Genera el documento legal para clientes Business (accountType === 'business')
 * de AV Finance SRL bajo el producto Alyto.
 *
 * Cumplimiento normativo:
 *   - RND 102400000021 — Bancarización (sección 6)
 *   - DS 5384          — Trazabilidad blockchain PSAV (sección 4)
 *   - RM 055/2025      — Documentación operaciones activos virtuales (sección 3)
 *   - NC12 + CTNAC 2-2024 — Fuente de tipo de cambio efectivo (sección 5)
 *   - Ley 843          — IVA/IUE (sección 7)
 *
 * Estructura del PDF (8 secciones):
 *   1. Cabecera Institucional  — AV Finance SRL, NIT, dirección, N° SRV-…
 *   2. Datos del Cliente B2B   — Razón social, NIT, businessId, rep. legal
 *   3. Detalle del Servicio    — Tipo operación, descripción
 *   4. Trazabilidad Blockchain — Stellar Network, TXID completo, link verificable
 *   5. Desglose Financiero     — BOB, tipo de cambio + fuente, USDC, fees, spread
 *   6. Información Bancarización — Cuentas origen/destino, N° operación bancaria
 *   7. Nota Legal/Fiscal       — DS 5384, RM 055, RND 102400000021, Ley 843
 *   8. QR de Verificación      — SHA-256 hash, URL verificable
 */

import PDFDocument from 'pdfkit';
import QRCode      from 'qrcode';
import crypto      from 'crypto';
import {
  COLOR_PRIMARY, COLOR_ACCENT, COLOR_GRAY, COLOR_LIGHT_BG,
  formatBOB, formatUSDC,
  drawSeparator, drawTableRow, drawInstitutionalHeader, drawFooterBar,
} from './pdfHelpers.js';

// ── Validación ───────────────────────────────────────────────────────────────

const CAMPOS_REQUERIDOS = [
  'invoiceNumber',
  'razonSocial',
  'taxId',
  'businessId',
  'tipoOperacion',
  'fechaHora',
  'txid',
  'montoOrigenBOB',
  'tipoDeCambio',
  'montoActivoDigital',
  'comisionServicio',
  'totalLiquidado',
];

function validarDTO(data) {
  const faltantes = CAMPOS_REQUERIDOS.filter(c => {
    const v = data[c];
    return v === undefined || v === null || v === '';
  });
  if (faltantes.length > 0) {
    throw new Error(
      `[B2B Invoice] Campos requeridos faltantes: ${faltantes.join(', ')}`,
    );
  }
}

// ── Helper: campo label:valor ────────────────────────────────────────────────

function drawLabelValue(doc, label, valor, marginL) {
  doc
    .font('Helvetica-Bold')
    .fontSize(8)
    .fillColor(COLOR_GRAY)
    .text(`${label}:`, marginL, doc.y, { continued: true, width: 180 })
    .font('Helvetica')
    .fillColor('#222222')
    .text(`  ${valor ?? '—'}`);
  doc.moveDown(0.1);
}

// ── Texto legal por defecto ──────────────────────────────────────────────────

const DEFAULT_LEGAL_FOOTER =
  'Este documento constituye el Comprobante Oficial de Servicio emitido por AV Finance SRL '
  + '(producto Alyto) conforme a la normativa boliviana vigente. '
  + 'Los activos virtuales operados constituyen un mecanismo alternativo de pago conforme al '
  + 'Decreto Supremo N° 5384 (Creación de ETF/PSAV) y la Resolución Ministerial N° 055/2025 (MEFP). '
  + 'La documentación de esta transacción cumple con las obligaciones establecidas en la '
  + 'RND N° 102400000021 (Bancarización) del Servicio de Impuestos Nacionales. '
  + 'Aspectos tributarios aplicables: IVA (Art. 4, Ley 843), IUE (Art. 47, Ley 843). '
  + 'El tipo de cambio utilizado corresponde a la tasa efectiva pagada en la fecha de la operación, '
  + 'conforme NC12 y Boletín Técnico CTNAC 2-2024. '
  + 'Trazabilidad blockchain verificable en Stellar Network (red pública, inmutable, descentralizada). '
  + 'AV Finance SRL — NIT: ' + (process.env.AV_FINANCE_NIT ?? '[pendiente]') + '.';

// ── Constructor del PDF ──────────────────────────────────────────────────────

function buildBusinessPDF(data) {
  return new Promise((resolvePromise, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];

    doc.on('data',  chunk => chunks.push(chunk));
    doc.on('end',   ()    => resolvePromise(Buffer.concat(chunks)));
    doc.on('error', err   => reject(err));

    const marginL  = doc.page.margins.left;
    const contentW = doc.page.width - marginL - doc.page.margins.right;

    // Helper: título de sección compacto
    const sectionTitle = (title) => {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(COLOR_PRIMARY)
        .text(title, marginL, doc.y);
      doc.moveDown(0.2);
    };

    // ── SECCIÓN 1 — CABECERA INSTITUCIONAL ────────────────────────────────
    drawInstitutionalHeader(doc, 'Comprobante Oficial de Servicio', data.invoiceNumber);

    // ── SECCIÓN 2 — DATOS DEL CLIENTE BUSINESS ───────────────────────────
    sectionTitle('DATOS DEL CLIENTE');
    drawLabelValue(doc, 'Razón Social',        data.razonSocial,        marginL);
    drawLabelValue(doc, 'NIT',                 data.taxId,              marginL);
    drawLabelValue(doc, 'ID Business Alyto',   data.businessId,         marginL);
    drawLabelValue(doc, 'Representante Legal',  data.representanteLegal, marginL);
    if (data.direccionCliente) drawLabelValue(doc, 'Dirección', data.direccionCliente, marginL);

    doc.moveDown(0.2);
    drawSeparator(doc);

    // ── SECCIÓN 3 — DETALLE DEL SERVICIO ──────────────────────────────────
    sectionTitle('DETALLE DEL SERVICIO');
    drawLabelValue(doc, 'Tipo de Operación',   data.tipoOperacion,       marginL);
    if (data.descripcionServicio) drawLabelValue(doc, 'Descripción', data.descripcionServicio, marginL);

    doc.moveDown(0.2);
    drawSeparator(doc);

    // ── SECCIÓN 4 — TRAZABILIDAD BLOCKCHAIN ───────────────────────────────
    sectionTitle('TRAZABILIDAD BLOCKCHAIN');

    const fechaFormateada = new Date(data.fechaHora).toLocaleString('es-BO', {
      timeZone: 'America/La_Paz',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'short',
    });

    drawLabelValue(doc, 'Fecha y Hora',  fechaFormateada,   marginL);
    drawLabelValue(doc, 'Red',           'Stellar Network', marginL);

    doc.moveDown(0.1);

    // TXID en caja monoespaciada
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR_GRAY)
      .text('TXID:', marginL, doc.y);
    doc.moveDown(0.1);

    const txidBoxY = doc.y;
    doc.rect(marginL, txidBoxY, contentW, 18).fill(COLOR_LIGHT_BG);
    doc.font('Courier').fontSize(7).fillColor('#1A1A1A')
      .text(data.txid, marginL + 4, txidBoxY + 5, { width: contentW - 8, lineBreak: false });
    doc.y = txidBoxY + 22;

    // Link de verificación solo si hay TXID real (no N/A)
    const hasStellarTx = data.txid && !data.txid.startsWith('N/A') && data.txid !== 'PENDIENTE';
    if (hasStellarTx) {
      doc.font('Helvetica').fontSize(7).fillColor(COLOR_ACCENT)
        .text(`Verificar: https://stellar.expert/explorer/public/tx/${data.txid}`, marginL, doc.y,
          { link: `https://stellar.expert/explorer/public/tx/${data.txid}`, underline: true });
      doc.moveDown(0.2);
    }

    doc.moveDown(0.2);
    drawSeparator(doc);

    // ── SECCIÓN 5 — DESGLOSE FINANCIERO ───────────────────────────────────
    sectionTitle('DESGLOSE FINANCIERO');

    const tableX = marginL;
    drawTableRow(doc, 'CONCEPTO', 'VALOR', {
      bold: true, bgColor: COLOR_PRIMARY, leftX: tableX, rowHeight: 16,
    });

    const fuenteTC = data.fuenteTipoCambio ? ` (${data.fuenteTipoCambio})` : '';

    const filas = [
      ['Monto Origen (BOB)',                      formatBOB(data.montoOrigenBOB)],
      ['Tipo de Cambio (BOB/USDC)' + fuenteTC,   `1 USDC = ${formatBOB(data.tipoDeCambio)}`],
      ['Activo Digital Entregado',                formatUSDC(data.montoActivoDigital)],
      ['Comisión de Servicio Alyto',              `- ${formatBOB(data.comisionServicio)}`],
    ];
    if (data.spreadFx != null) {
      filas.push(['Spread FX', `- ${formatBOB(data.spreadFx)}`]);
    }

    filas.forEach(([concepto, valor], i) => {
      drawTableRow(doc, concepto, valor, {
        bgColor: i % 2 === 0 ? '#F9FAFB' : null, leftX: tableX, rowHeight: 16,
      });
    });

    drawTableRow(doc, 'TOTAL LIQUIDADO (BOB)', formatBOB(data.totalLiquidado), {
      bold: true, bgColor: COLOR_PRIMARY, leftX: tableX, rowHeight: 16,
    });

    doc.moveDown(0.3);
    drawSeparator(doc, COLOR_ACCENT);

    // ── SECCIÓN 6 — BANCARIZACIÓN ─────────────────────────────────────────
    sectionTitle('INFORMACIÓN DE BANCARIZACIÓN');

    const b = data.bancarizacion ?? {};
    const hasBancData = b.payerBankName || b.bankOperationNumber;

    if (hasBancData) {
      drawLabelValue(doc, 'Banco Origen',          b.payerBankName,         marginL);
      drawLabelValue(doc, 'Cuenta Origen',         b.payerAccountNumber,    marginL);
      drawLabelValue(doc, 'Banco Destino',         b.receiverBankName,      marginL);
      drawLabelValue(doc, 'Cuenta Destino',        b.receiverAccountNumber, marginL);
      drawLabelValue(doc, 'N° Operación Bancaria', b.bankOperationNumber,   marginL);
    } else {
      const reqNote = data.montoOrigenBOB >= 50000
        ? 'Transacción ≥ Bs 50.000 — respaldo de bancarización obligatorio (RND 102400000021). Datos pendientes.'
        : 'Bajo Bs 50.000 — respaldo de bancarización no exigido por normativa.';
      doc.font('Helvetica').fontSize(7.5).fillColor(COLOR_GRAY)
        .text(reqNote, marginL, doc.y, { width: contentW });
    }

    doc.moveDown(0.2);
    drawSeparator(doc);

    // ── SECCIÓN 7 — NOTA LEGAL + QR (lado a lado) ────────────────────────
    const textoLegal = data.textoLegalFooter
      ?? process.env.AV_FINANCE_B2B_LEGAL_FOOTER
      ?? DEFAULT_LEGAL_FOOTER;

    const qrSize     = 60;
    const qrGap      = 8;
    const hasQR      = !!data.qrDataUrl;
    const legalWidth  = hasQR ? contentW - qrSize - qrGap : contentW;

    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLOR_PRIMARY)
      .text('NOTA LEGAL', marginL, doc.y);
    doc.moveDown(0.15);

    const legalStartY = doc.y;
    doc.font('Helvetica').fontSize(6.5).fillColor(COLOR_GRAY)
      .text(textoLegal, marginL, doc.y, { width: legalWidth, align: 'justify' });

    // QR al lado derecho de la nota legal
    if (hasQR) {
      const qrX = doc.page.width - doc.page.margins.right - qrSize;
      doc.image(data.qrDataUrl, qrX, legalStartY, { width: qrSize, height: qrSize });
      doc.font('Helvetica').fontSize(6).fillColor(COLOR_GRAY)
        .text('Verificar', qrX, legalStartY + qrSize + 2, { width: qrSize, align: 'center' });
      // Ensure doc.y is past the QR if legal text was shorter
      if (doc.y < legalStartY + qrSize + 14) doc.y = legalStartY + qrSize + 14;
    }

    doc.moveDown(0.3);

    // Pie de firma institucional
    const nit = process.env.AV_FINANCE_NIT ?? '[NIT pendiente]';
    doc.font('Helvetica').fontSize(7).fillColor(COLOR_GRAY)
      .text(
        `Comprobante N° ${data.invoiceNumber}  ·  Emitido: ${new Date(data.fechaHora).toLocaleDateString('es-BO')}  ·  AV Finance SRL  ·  NIT: ${nit}`,
        marginL, doc.y, { align: 'center', width: contentW },
      );

    // Barra inferior
    drawFooterBar(doc);

    doc.end();
  });
}

// ── Generación del hash de verificación ──────────────────────────────────────

/**
 * @param {string} invoiceNumber
 * @param {string} txid
 * @param {string|Date} fechaHora
 * @returns {string} SHA-256 hex
 */
export function generateVerificationHash(invoiceNumber, txid, fechaHora) {
  return crypto
    .createHash('sha256')
    .update(`${invoiceNumber}|${txid}|${new Date(fechaHora).toISOString()}`)
    .digest('hex');
}

// ── Exportación Principal ────────────────────────────────────────────────────

/**
 * Genera el Comprobante Oficial de Servicio B2B para AV Finance SRL.
 *
 * @param {BusinessInvoiceDTO} data
 * @returns {Promise<{ buffer: Buffer, filename: string, verificationHash: string }>}
 *
 * @typedef {Object} BusinessInvoiceDTO
 * @property {string}      invoiceNumber         - 'SRV-202604-XXXXXX'
 * @property {string}      razonSocial           - Razón social del cliente business
 * @property {string}      taxId                 - NIT del cliente
 * @property {string}      businessId            - 'BIZ-XXXXXXXX'
 * @property {string}      [representanteLegal]  - Nombre del representante legal
 * @property {string}      [direccionCliente]    - Dirección del cliente
 * @property {string}      tipoOperacion         - 'Cross-Border Payment' | 'Liquidación de Activo Digital'
 * @property {string}      [descripcionServicio] - Descripción libre del servicio
 * @property {string|Date} fechaHora             - ISO 8601
 * @property {string}      txid                  - Hash Stellar (64 chars hex)
 * @property {number}      montoOrigenBOB        - Monto en BOB
 * @property {number}      tipoDeCambio          - Tasa BOB/USDC
 * @property {string}      [fuenteTipoCambio]    - 'BCB' | 'Binance P2P' | 'paralelo'
 * @property {number}      montoActivoDigital    - Cantidad de USDC
 * @property {number}      comisionServicio      - Fee en BOB
 * @property {number}      [spreadFx]            - Spread FX en BOB
 * @property {number}      totalLiquidado        - Neto en BOB
 * @property {object}      [bancarizacion]       - Datos de bancarización (RND 102400000021)
 * @property {string}      [textoLegalFooter]    - Texto legal override
 */
export async function generateBusinessInvoice(data) {
  try {
    validarDTO(data);

    // Generar hash de verificación
    const verificationHash = generateVerificationHash(
      data.invoiceNumber, data.txid, data.fechaHora,
    );

    // Generar QR con URL de verificación
    const verifyBaseUrl = process.env.ALYTO_VERIFY_BASE_URL ?? 'https://alyto.app/verify';
    const verificationUrl = `${verifyBaseUrl}/${verificationHash}`;

    let qrDataUrl = null;
    try {
      qrDataUrl = await QRCode.toDataURL(verificationUrl, {
        width:  200,
        margin: 1,
        color:  { dark: '#1A3A5C', light: '#FFFFFF' },
      });
    } catch {
      console.warn('[B2B Invoice] No se pudo generar QR de verificación.');
    }

    // Construir PDF
    const buffer = await buildBusinessPDF({ ...data, qrDataUrl });

    const fecha    = new Date(data.fechaHora).toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `factura_b2b_${data.invoiceNumber}_${fecha}.pdf`;

    return { buffer, filename, verificationHash };

  } catch (error) {
    console.error('[B2B Invoice] Error al generar Comprobante Oficial de Servicio:', {
      invoiceNumber: data?.invoiceNumber,
      error:         error.message,
    });
    throw error;
  }
}
