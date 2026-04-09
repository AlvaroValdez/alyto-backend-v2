/**
 * pdfHelpers.js — Utilidades compartidas para generación de PDFs Alyto
 *
 * Extraídas de pdfGenerator.js para reutilización entre:
 *   - Comprobante Oficial de Transacción (retail, pdfGenerator.js)
 *   - Comprobante Oficial de Servicio B2B (businessInvoiceGenerator.js)
 */

import { existsSync }  from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Paleta institucional Alyto ───────────────────────────────────────────────

export const COLOR_PRIMARY  = '#1A3A5C';
export const COLOR_ACCENT   = '#F5A623';
export const COLOR_GRAY     = '#666666';
export const COLOR_LIGHT_BG = '#F5F7FA';

// ── Logo ─────────────────────────────────────────────────────────────────────

/**
 * Resuelve la ruta al logo con fallback en cascada:
 *   1. Variable de entorno AV_FINANCE_LOGO_PATH (producción / S3 local)
 *   2. Ruta relativa al repo de logos del workspace de desarrollo
 *   3. null → cabecera sin imagen
 */
export function resolveLogoPath() {
  if (process.env.AV_FINANCE_LOGO_PATH && existsSync(process.env.AV_FINANCE_LOGO_PATH)) {
    return process.env.AV_FINANCE_LOGO_PATH;
  }
  const devPath = resolve(__dirname, '../../../Logos/LogoAlyto.png');
  if (existsSync(devPath)) return devPath;
  return null;
}

// ── Formateo de montos ───────────────────────────────────────────────────────

/**
 * Formatea un número al estilo boliviano: Bs. 1.250,00
 * Separador de miles: punto (.)  |  Decimal: coma (,)
 */
export function formatBOB(amount) {
  const [intPart, decPart] = Number(amount).toFixed(2).split('.');
  const intFormatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `Bs. ${intFormatted},${decPart}`;
}

/**
 * Formatea un número como cantidad de USDC con 7 decimales.
 */
export function formatUSDC(amount) {
  return `${Number(amount).toFixed(7)} USDC`;
}

// ── Helpers de dibujo PDF ────────────────────────────────────────────────────

/** Dibuja una línea separadora horizontal a lo ancho de la página. */
export function drawSeparator(doc, color = '#CCCCCC') {
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(color)
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.5);
}

/**
 * Dibuja una fila de tabla de dos columnas (concepto | valor).
 * @param {PDFDocument} doc
 * @param {string} concepto
 * @param {string} valor
 * @param {object} opts
 * @param {boolean} opts.bold      - Negrita en concepto
 * @param {string}  opts.bgColor   - Color de fondo (hex) para resaltar
 * @param {number}  opts.leftX     - X de inicio
 * @param {number}  opts.colWidth  - Ancho de la columna izquierda
 * @param {number}  opts.rowHeight - Alto de la fila
 */
export function drawTableRow(doc, concepto, valor, {
  bold     = false,
  bgColor  = null,
  leftX    = null,
  colWidth = 240,
  rowHeight = 18,
} = {}) {
  const x      = leftX ?? doc.page.margins.left;
  const totalW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y      = doc.y;

  if (bgColor) {
    doc.rect(x, y, totalW, rowHeight).fill(bgColor);
  }

  const font = bold ? 'Helvetica-Bold' : 'Helvetica';

  doc
    .font(font)
    .fontSize(9)
    .fillColor(bgColor ? '#FFFFFF' : '#222222')
    .text(concepto, x + 4, y + 4, { width: colWidth, lineBreak: false });

  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(bgColor ? '#FFFFFF' : '#222222')
    .text(valor, x + colWidth + 4, y + 4, {
      width:     totalW - colWidth - 8,
      align:     'right',
      lineBreak: false,
    });

  doc.moveDown(0);
  doc.y = y + rowHeight;
}

// ── Cabecera institucional reutilizable ──────────────────────────────────────

/**
 * Dibuja la cabecera estándar AV Finance SRL: barra acento, logo, razón social,
 * NIT, dirección, título del documento y número correlativo.
 *
 * @param {PDFDocument} doc
 * @param {string} titulo           — "Comprobante Oficial de Transacción" o "Comprobante Oficial de Servicio"
 * @param {string} numeroCorrelativo — "BOL-202604-XXXXXX" o "SRV-202604-XXXXXX"
 */
export function drawInstitutionalHeader(doc, titulo, numeroCorrelativo) {
  const pageW    = doc.page.width;
  const marginL  = doc.page.margins.left;
  const contentW = pageW - marginL - doc.page.margins.right;

  // Barra superior acento
  doc.rect(0, 0, pageW, 8).fill(COLOR_ACCENT);

  // Logo
  const logoPath = resolveLogoPath();
  const logoH    = 44;
  const logoY    = 18;

  if (logoPath) {
    const logoW = Math.round(logoH * (604 / 217));
    const logoX = (pageW - logoW) / 2;
    doc.image(logoPath, logoX, logoY, { height: logoH });
    doc.y = logoY + logoH + 10;
  } else {
    doc
      .font('Helvetica-Bold')
      .fontSize(22)
      .fillColor(COLOR_PRIMARY)
      .text('alyto', marginL, logoY + 6, { align: 'center', width: contentW });
    doc.y = logoY + logoH + 10;
  }

  // Razón social
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor(COLOR_PRIMARY)
    .text('AV Finance SRL', marginL, doc.y, { align: 'center', width: contentW });

  doc.moveDown(0.3);

  const nit       = process.env.AV_FINANCE_NIT    ?? '[NIT pendiente — configurar AV_FINANCE_NIT]';
  const direccion = process.env.AV_FINANCE_ADDRESS ?? '[Dirección pendiente — configurar AV_FINANCE_ADDRESS]';

  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(COLOR_GRAY)
    .text(`NIT: ${nit}  ·  ${direccion}`, marginL, doc.y, { align: 'center', width: contentW });

  doc.moveDown(0.5);

  // Título del documento
  doc
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor(COLOR_PRIMARY)
    .text(titulo, marginL, doc.y, { align: 'center', width: contentW });

  doc.moveDown(0.3);

  // Número correlativo
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(COLOR_GRAY)
    .text(`N° ${numeroCorrelativo}`, marginL, doc.y, { align: 'center', width: contentW });

  doc.moveDown(0.8);
  drawSeparator(doc, COLOR_ACCENT);
  doc.moveDown(0.5);
}

// ── Footer institucional ─────────────────────────────────────────────────────

/**
 * Dibuja la barra inferior acento del PDF.
 */
export function drawFooterBar(doc) {
  const pageH = doc.page.height;
  const pageW = doc.page.width;
  doc.rect(0, pageH - 8, pageW, 8).fill(COLOR_ACCENT);
}
