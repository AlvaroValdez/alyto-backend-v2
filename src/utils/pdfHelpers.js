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

// ── Saneamiento de valores de entorno ────────────────────────────────────────

/**
 * Devuelve el valor de entorno limpio, o `null` si está vacío o es un
 * placeholder sin completar (ej. "<COMPLETAR: …>", "[NIT pendiente]").
 * Evita que textos placeholder se impriman literalmente en el PDF.
 * @param {string|undefined} val
 * @returns {string|null}
 */
export function cleanEnvValue(val) {
  if (!val || typeof val !== 'string') return null;
  const t = val.trim();
  if (!t) return null;
  if (/^[<[]/.test(t)) return null;                       // empieza con < o [
  if (/COMPLETAR|PENDIENTE|TODO|PLACEHOLDER/i.test(t)) return null;
  return t;
}

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
  // Logo incluido en el repo (funciona en Render y local)
  const repoPath = resolve(__dirname, '../assets/LogoAlyto.png');
  if (existsSync(repoPath)) return repoPath;
  // Fallback: workspace de desarrollo local
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

/**
 * URL de Stellar Expert para un TXID, según la red del entorno.
 * Prod (VPS) = mainnet → 'public'; staging = testnet.
 */
export function stellarExplorerTxUrl(txid) {
  const net = process.env.STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${net}/tx/${txid}`;
}

// ── Helpers de dibujo PDF ────────────────────────────────────────────────────

/**
 * Determina si un color de fondo (hex) es claro, para elegir texto oscuro/claro.
 * Usa luminancia relativa percibida (ITU-R BT.601).
 * @param {string} hex - color #RRGGBB
 * @returns {boolean} true si el fondo es claro (→ usar texto oscuro)
 */
function isLightBackground(hex) {
  if (!hex || typeof hex !== 'string') return true;
  const c = hex.replace('#', '');
  if (c.length < 6) return true;
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  // Luminancia 0–255; umbral 150 separa fondos claros de oscuros.
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
}

/** Dibuja una línea separadora horizontal a lo ancho de la página. */
export function drawSeparator(doc, color = '#CCCCCC') {
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(color)
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.25);
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

  // El color del texto depende de la LUMINANCIA del fondo, no de si hay fondo.
  // Antes: bgColor ? blanco : oscuro → las filas con fondo claro (#F9FAFB)
  // quedaban con texto blanco INVISIBLE. Ahora: fondo claro → texto oscuro.
  const textColor = (!bgColor || isLightBackground(bgColor)) ? '#222222' : '#FFFFFF';

  const font = bold ? 'Helvetica-Bold' : 'Helvetica';

  doc
    .font(font)
    .fontSize(9)
    .fillColor(textColor)
    .text(concepto, x + 4, y + 4, { width: colWidth, lineBreak: false });

  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(textColor)
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
  doc.rect(0, 0, pageW, 6).fill(COLOR_ACCENT);

  // Logo
  const logoPath = resolveLogoPath();
  const logoH    = 36;
  const logoY    = 14;

  if (logoPath) {
    const logoW = Math.round(logoH * (604 / 217));
    const logoX = (pageW - logoW) / 2;
    doc.image(logoPath, logoX, logoY, { height: logoH });
    doc.y = logoY + logoH + 6;
  } else {
    doc
      .font('Helvetica-Bold')
      .fontSize(18)
      .fillColor(COLOR_PRIMARY)
      .text('alyto', marginL, logoY + 4, { align: 'center', width: contentW });
    doc.y = logoY + logoH + 6;
  }

  // Razón social + NIT en una línea
  const nit       = cleanEnvValue(process.env.AV_FINANCE_NIT)     ?? 'En trámite ante el SIN';
  const direccion = cleanEnvValue(process.env.AV_FINANCE_ADDRESS) ?? '';

  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor(COLOR_PRIMARY)
    .text('AV Finance SRL', marginL, doc.y, { align: 'center', width: contentW });

  doc.moveDown(0.15);

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(COLOR_GRAY)
    .text(`NIT: ${nit}${direccion ? '  ·  ' + direccion : ''}`, marginL, doc.y, { align: 'center', width: contentW });

  doc.moveDown(0.3);

  // Título del documento + número en una línea
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(COLOR_PRIMARY)
    .text(`${titulo}  —  N° ${numeroCorrelativo}`, marginL, doc.y, { align: 'center', width: contentW });

  doc.moveDown(0.4);
  drawSeparator(doc, COLOR_ACCENT);
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
