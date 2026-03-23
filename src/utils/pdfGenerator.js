/**
 * pdfGenerator.js — Generador del Comprobante Oficial de Transacción
 *
 * Genera el documento legal exigido por AV Finance SRL (Bolivia) para toda
 * operación liquidada bajo el Escenario C (Corredor Bolivia).
 *
 * SKILL: Compliance_Bolivia_Alyto — estructura y terminología obligatoria.
 *
 * Estructura del PDF (5 secciones invariantes, en este orden):
 *   1. Cabecera Institucional  — AV Finance SRL, NIT, dirección, N° comprobante
 *   2. Datos del Cliente (KYC) — Nombre, NIT/CI, tipo documento, código Alyto
 *   3. Trazabilidad Web3       — Fecha, tipo operación, Red Stellar, TXID
 *   4. Desglose Financiero     — BOB, tipo de cambio, USDC, fees, total
 *   5. Footer Legal            — Normativa IUE/IVA (configurable por entorno)
 *
 * COMPLIANCE: Terminología prohibida ausente.
 * El texto del PDF usa: "Liquidación de Activo Digital", "CrossBorder Payment",
 * "payin", "payout" — nunca los términos restringidos.
 *
 * @module pdfGenerator
 */

import PDFDocument from 'pdfkit';
import { existsSync }  from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resuelve la ruta al logo con fallback en cascada:
 *   1. Variable de entorno AV_FINANCE_LOGO_PATH (producción / S3 local)
 *   2. Ruta relativa al repo de logos del workspace de desarrollo
 *   3. null → cabecera sin imagen
 */
function resolveLogoPath() {
  if (process.env.AV_FINANCE_LOGO_PATH && existsSync(process.env.AV_FINANCE_LOGO_PATH)) {
    return process.env.AV_FINANCE_LOGO_PATH;
  }
  // Fallback dev: logos en el workspace del proyecto
  const devPath = resolve(__dirname, '../../../Logos/LogoAlyto.png');
  if (existsSync(devPath)) return devPath;
  return null;
}

// ─── Validación de campos requeridos ─────────────────────────────────────────

const CAMPOS_REQUERIDOS = [
  'numeroComprobante',
  'nombreCliente',
  'nitOci',
  'tipoDocumento',
  'codigoClienteAlyto',
  'fechaHora',
  'tipoOperacion',
  'txid',
  'montoFiatRecibido',
  'tipoDeCambio',
  'montoActivoEntregado',
  'comisionServicio',
  'totalLiquidado',
];

/**
 * @param {TransaccionBoliviaDTO} data
 * @throws {Error} si algún campo requerido falta o está vacío
 */
function validarDTO(data) {
  const faltantes = CAMPOS_REQUERIDOS.filter(campo => {
    const valor = data[campo];
    return valor === undefined || valor === null || valor === '';
  });
  if (faltantes.length > 0) {
    throw new Error(
      `[Compliance Bolivia] Campos requeridos faltantes en el DTO: ${faltantes.join(', ')}`,
    );
  }
}

// ─── Formateo de montos bolivianos ────────────────────────────────────────────

/**
 * Formatea un número al estilo boliviano: Bs. 1.250,00
 * Separador de miles: punto (.)  |  Decimal: coma (,)
 *
 * @param {number} amount
 * @returns {string}
 */
function formatBOB(amount) {
  const [intPart, decPart] = Number(amount).toFixed(2).split('.');
  const intFormatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `Bs. ${intFormatted},${decPart}`;
}

/**
 * Formatea un número como cantidad de USDC con 7 decimales.
 * @param {number} amount
 * @returns {string}
 */
function formatUSDC(amount) {
  return `${Number(amount).toFixed(7)} USDC`;
}

// ─── Helpers de dibujo PDF ────────────────────────────────────────────────────

/** Dibuja una línea separadora horizontal a lo ancho de la página. */
function drawSeparator(doc, color = '#CCCCCC') {
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
function drawTableRow(doc, concepto, valor, {
  bold     = false,
  bgColor  = null,
  leftX    = null,
  colWidth = 240,
  rowHeight = 18,
} = {}) {
  const x      = leftX ?? doc.page.margins.left;
  const totalW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y      = doc.y;

  // Fondo de fila (para resaltar el total)
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

// ─── Constructor principal del PDF ────────────────────────────────────────────

/**
 * Construye el PDF usando pdfkit y lo retorna como Buffer.
 * @param {TransaccionBoliviaDTO} data
 * @returns {Promise<Buffer>}
 */
function buildPDF(data) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data',  chunk => chunks.push(chunk));
    doc.on('end',   ()    => resolve(Buffer.concat(chunks)));
    doc.on('error', err   => reject(err));

    const pageW  = doc.page.width;
    const marginL = doc.page.margins.left;
    const contentW = pageW - marginL - doc.page.margins.right;

    // Paleta institucional Alyto
    const COLOR_PRIMARY   = '#1A3A5C';  // Azul Alyto
    const COLOR_ACCENT    = '#F5A623';  // Amarillo Alyto
    const COLOR_GRAY      = '#666666';
    const COLOR_LIGHT_BG  = '#F5F7FA';

    // ═══════════════════════════════════════════════════════════════════════
    // SECCIÓN 1 — CABECERA INSTITUCIONAL
    // ═══════════════════════════════════════════════════════════════════════

    // Barra superior con color acento
    doc.rect(0, 0, pageW, 8).fill(COLOR_ACCENT);

    // Logo — centrado en la cabecera
    const logoPath  = resolveLogoPath();
    const logoH     = 44;
    const logoY     = 18;

    if (logoPath) {
      // Calcular ancho proporcional: logo original 604×217 → height=44 → width≈122
      const logoW = Math.round(logoH * (604 / 217));
      const logoX = (pageW - logoW) / 2;
      doc.image(logoPath, logoX, logoY, { height: logoH });
      doc.y = logoY + logoH + 10;
    } else {
      // Fallback tipográfico si no hay imagen
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

    // NIT y dirección desde variables de entorno (nunca hardcodeados)
    const nit       = process.env.AV_FINANCE_NIT      ?? '[NIT pendiente — configurar AV_FINANCE_NIT]';
    const direccion = process.env.AV_FINANCE_ADDRESS   ?? '[Dirección pendiente — configurar AV_FINANCE_ADDRESS]';

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLOR_GRAY)
      .text(`NIT: ${nit}  ·  ${direccion}`, marginL, doc.y, { align: 'center', width: contentW });

    doc.moveDown(0.5);

    // Nombre del documento (invariable por normativa)
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor(COLOR_PRIMARY)
      .text('Comprobante Oficial de Transacción', marginL, doc.y, {
        align: 'center',
        width: contentW,
      });

    doc.moveDown(0.3);

    // Número de comprobante correlativo
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLOR_GRAY)
      .text(`N° ${data.numeroComprobante}`, marginL, doc.y, { align: 'center', width: contentW });

    doc.moveDown(0.8);
    drawSeparator(doc, COLOR_ACCENT);
    doc.moveDown(0.5);

    // ═══════════════════════════════════════════════════════════════════════
    // SECCIÓN 2 — DATOS DEL CLIENTE (KYC)
    // ═══════════════════════════════════════════════════════════════════════

    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(COLOR_PRIMARY)
      .text('DATOS DEL CLIENTE', marginL, doc.y);

    doc.moveDown(0.4);

    // Fondo de la sección KYC
    const kycSectionY = doc.y;

    const kycFields = [
      ['Nombre / Razón Social',   data.nombreCliente],
      [`${data.tipoDocumento}`,   data.nitOci],
      ['Tipo de Documento',       data.tipoDocumento],
      ['Código Cliente Alyto',    data.codigoClienteAlyto],
    ];

    kycFields.forEach(([label, valor]) => {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(COLOR_GRAY)
        .text(`${label}:`, marginL, doc.y, { continued: true, width: 180 })
        .font('Helvetica')
        .fillColor('#222222')
        .text(`  ${valor}`);
      doc.moveDown(0.2);
    });

    doc.moveDown(0.5);
    drawSeparator(doc);
    doc.moveDown(0.5);

    // ═══════════════════════════════════════════════════════════════════════
    // SECCIÓN 3 — TRAZABILIDAD WEB3  ← SECCIÓN SOLICITADA PARA REVISIÓN
    // ═══════════════════════════════════════════════════════════════════════

    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(COLOR_PRIMARY)
      .text('TRAZABILIDAD BLOCKCHAIN', marginL, doc.y);

    doc.moveDown(0.4);

    // Fecha y hora — ISO 8601 con timezone explícito
    const fechaFormateada = new Date(data.fechaHora).toLocaleString('es-BO', {
      timeZone:     'America/La_Paz',
      day:          '2-digit',
      month:        '2-digit',
      year:         'numeric',
      hour:         '2-digit',
      minute:       '2-digit',
      second:       '2-digit',
      timeZoneName: 'short',
    });

    doc
      .font('Helvetica-Bold').fontSize(9).fillColor(COLOR_GRAY)
      .text('Fecha y Hora:', marginL, doc.y, { continued: true, width: 180 })
      .font('Helvetica').fillColor('#222222')
      .text(`  ${fechaFormateada}`);

    doc.moveDown(0.2);

    doc
      .font('Helvetica-Bold').fontSize(9).fillColor(COLOR_GRAY)
      .text('Tipo de Operación:', marginL, doc.y, { continued: true, width: 180 })
      .font('Helvetica').fillColor('#222222')
      .text(`  ${data.tipoOperacion}`);

    doc.moveDown(0.2);

    doc
      .font('Helvetica-Bold').fontSize(9).fillColor(COLOR_GRAY)
      .text('Red Utilizada:', marginL, doc.y, { continued: true, width: 180 })
      .font('Helvetica').fillColor('#222222')
      .text('  Stellar Network');    // Valor fijo — no parametrizar

    doc.moveDown(0.5);

    // TXID — impreso COMPLETO en fuente monoespaciada (requisito del skill)
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLOR_GRAY)
      .text('Hash de Transacción Blockchain (TXID):', marginL, doc.y);

    doc.moveDown(0.2);

    // Fondo destacado para el TXID
    const txidBoxY = doc.y;
    doc.rect(marginL, txidBoxY, contentW, 24).fill(COLOR_LIGHT_BG);

    // TXID completo en Courier (monoespaciado) — obligatorio por normativa
    doc
      .font('Courier')
      .fontSize(7.5)
      .fillColor('#1A1A1A')
      .text(data.txid, marginL + 6, txidBoxY + 7, {
        width:     contentW - 12,
        lineBreak: false,
        ellipsis:  false,   // NUNCA truncar el TXID — debe ser completo
      });

    doc.y = txidBoxY + 30;
    doc.moveDown(0.2);

    // Link de verificación en Stellar Expert — exigido por el skill
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR_ACCENT)
      .text(
        `Verificable en: https://stellar.expert/explorer/public/tx/${data.txid}`,
        marginL,
        doc.y,
        { link: `https://stellar.expert/explorer/public/tx/${data.txid}`, underline: true },
      );

    doc.moveDown(0.8);
    drawSeparator(doc);
    doc.moveDown(0.5);

    // ═══════════════════════════════════════════════════════════════════════
    // SECCIÓN 4 — DESGLOSE FINANCIERO
    // ═══════════════════════════════════════════════════════════════════════

    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(COLOR_PRIMARY)
      .text('DESGLOSE FINANCIERO', marginL, doc.y);

    doc.moveDown(0.5);

    // Encabezado de tabla
    const tableX = marginL;
    drawTableRow(doc, 'CONCEPTO', 'VALOR', {
      bold:    true,
      bgColor: COLOR_PRIMARY,
      leftX:   tableX,
    });

    doc.moveDown(0);

    // Filas del desglose
    const filas = [
      ['Monto Fiat Recibido (BOB)',                 formatBOB(data.montoFiatRecibido)],
      ['Tipo de Cambio aplicado (BOB/USDC)',         `1 USDC = ${formatBOB(data.tipoDeCambio)}`],
      ['Activo Digital Entregado',                  formatUSDC(data.montoActivoEntregado)],
      ['Comisión de Servicio Alyto',                `- ${formatBOB(data.comisionServicio)}`],
    ];

    filas.forEach(([concepto, valor], i) => {
      drawTableRow(doc, concepto, valor, {
        bgColor: i % 2 === 0 ? '#F9FAFB' : null,
        leftX:   tableX,
      });
    });

    // Fila de total — resaltada en color primario
    doc.moveDown(0.1);
    drawTableRow(doc, 'TOTAL LIQUIDADO (BOB)', formatBOB(data.totalLiquidado), {
      bold:    true,
      bgColor: COLOR_PRIMARY,
      leftX:   tableX,
    });

    doc.moveDown(1);
    drawSeparator(doc, COLOR_ACCENT);
    doc.moveDown(0.5);

    // ═══════════════════════════════════════════════════════════════════════
    // SECCIÓN 5 — FOOTER LEGAL (Normativa IUE/IVA)
    // ═══════════════════════════════════════════════════════════════════════

    // Texto legal desde variable de entorno — configurable por asesoría impositiva
    const textoLegal = data.textoLegalFooter
      ?? process.env.AV_FINANCE_LEGAL_FOOTER
      ?? '[TEXTO LEGAL PENDIENTE — Completar con asesoría impositiva boliviana. '
       + 'Espacio reservado para normativa IUE/IVA y requisitos de bancarización '
       + 'según Ley 843 y reglamentos del SIN Bolivia.]';

    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(COLOR_PRIMARY)
      .text('NOTA LEGAL', marginL, doc.y);

    doc.moveDown(0.3);

    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(COLOR_GRAY)
      .text(textoLegal, marginL, doc.y, { width: contentW, align: 'justify' });

    doc.moveDown(0.8);

    // Pie de firma institucional
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(COLOR_GRAY)
      .text(
        `Comprobante N° ${data.numeroComprobante}  ·  `
        + `Emitido: ${new Date(data.fechaHora).toLocaleDateString('es-BO')}  ·  `
        + `AV Finance SRL  ·  NIT: ${nit}`,
        marginL,
        doc.y,
        { align: 'center', width: contentW },
      );

    // Barra inferior con color acento
    const pageH = doc.page.height;
    doc.rect(0, pageH - 8, pageW, 8).fill(COLOR_ACCENT);

    doc.end();
  });
}

// ─── Exportación Principal ────────────────────────────────────────────────────

/**
 * Genera el Comprobante Oficial de Transacción para AV Finance SRL (Bolivia).
 *
 * @param {TransaccionBoliviaDTO} data - Datos completos de la operación
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 *
 * @typedef {Object} TransaccionBoliviaDTO
 * @property {string}       numeroComprobante      - Ej: 'BOL-202503-000142'
 * @property {string}       nombreCliente          - Nombre o razón social del cliente
 * @property {string}       nitOci                 - NIT empresarial o CI boliviano
 * @property {'NIT'|'CI'}   tipoDocumento
 * @property {string}       codigoClienteAlyto     - ID interno Alyto del usuario
 * @property {string|Date}  fechaHora              - ISO 8601 con timezone
 * @property {string}       tipoOperacion          - Ej: 'Liquidación de Activo Digital'
 * @property {string}       txid                   - Hash Stellar (64 chars hex)
 * @property {number}       montoFiatRecibido      - Monto en BOB
 * @property {number}       tipoDeCambio           - Tasa BOB/USDC
 * @property {number}       montoActivoEntregado   - Cantidad de USDC
 * @property {number}       comisionServicio       - Fee Alyto en BOB
 * @property {number}       totalLiquidado         - montoFiatRecibido - comisionServicio
 * @property {string}       [textoLegalFooter]     - Texto legal (opcional, usa env si no se pasa)
 */
export async function generateOfficialReceipt(data) {
  try {
    validarDTO(data);

    const buffer = await buildPDF(data);

    // Nombre de archivo sugerido según normativa del skill
    const fecha    = new Date(data.fechaHora).toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `comprobante_${data.numeroComprobante}_${fecha}.pdf`;

    return { buffer, filename };

  } catch (error) {
    // Loguear sin exponer datos sensibles del cliente (NIT/CI)
    console.error('[Compliance Bolivia] Error al generar Comprobante Oficial:', {
      numeroComprobante: data?.numeroComprobante,
      error:             error.message,
    });
    throw error;
  }
}

// Alias para compatibilidad con fallbackExecutor (Compliance_Bolivia_Alyto naming)
export { generateOfficialReceipt as generarComprobanteBolivia };
