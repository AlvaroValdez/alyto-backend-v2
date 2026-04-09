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
import {
  COLOR_PRIMARY, COLOR_ACCENT, COLOR_GRAY, COLOR_LIGHT_BG,
  resolveLogoPath, formatBOB, formatUSDC,
  drawSeparator, drawTableRow, drawInstitutionalHeader, drawFooterBar,
} from './pdfHelpers.js';

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

    // ═══════════════════════════════════════════════════════════════════════
    // SECCIÓN 1 — CABECERA INSTITUCIONAL (compartida vía pdfHelpers)
    // ═══════════════════════════════════════════════════════════════════════

    drawInstitutionalHeader(doc, 'Comprobante Oficial de Transacción', data.numeroComprobante);

    const nit = process.env.AV_FINANCE_NIT ?? '[NIT pendiente]';

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
    drawFooterBar(doc);

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
