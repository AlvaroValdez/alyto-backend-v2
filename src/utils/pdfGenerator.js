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
import QRCode      from 'qrcode';
import {
  COLOR_PRIMARY, COLOR_ACCENT, COLOR_GRAY, COLOR_LIGHT_BG,
  resolveLogoPath, formatBOB, formatUSDC, formatRate, cleanEnvValue, stellarExplorerTxUrl,
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
function buildPDF(data, qrBuffer) {
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

    const nit = cleanEnvValue(process.env.AV_FINANCE_NIT) ?? 'En trámite ante el SIN';

    // ═══════════════════════════════════════════════════════════════════════
    // SECCIÓN 2 — DATOS DEL CLIENTE (KYC)
    // ═══════════════════════════════════════════════════════════════════════

    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(COLOR_PRIMARY)
      .text('DATOS DEL CLIENTE', marginL, doc.y);

    doc.moveDown(0.4);

    const LABEL_W = 175;  // columna izquierda para el label

    // Layout dos columnas: label izquierda (LABEL_W), valor derecha (resto de la página).
    // Evita la superposición que causaba { continued: true, width: 180 }.
    const kycRows = [
      ['Nombre / Razón Social',   data.nombreCliente],
      [data.tipoDocumento === 'NIT' ? 'NIT Empresarial' : 'Cédula de Identidad', data.nitOci],
      ['Código Cliente Alyto',    data.codigoClienteAlyto],
    ];

    kycRows.forEach(([label, valor]) => {
      const rowY = doc.y;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR_GRAY)
        .text(`${label}:`, marginL, rowY, { width: LABEL_W, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor('#222222')
        .text(`${valor}`, marginL + LABEL_W, rowY, { width: contentW - LABEL_W });
      // Avanzar al menos 16pt aunque el valor no haya wrapeado
      doc.y = Math.max(doc.y, rowY + 16);
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

    // Fecha y hora en zona horaria Bolivia (UTC-4)
    const fechaFormateada = new Date(data.fechaHora).toLocaleString('es-BO', {
      timeZone: 'America/La_Paz',
      day:      '2-digit',
      month:    '2-digit',
      year:     'numeric',
      hour:     '2-digit',
      minute:   '2-digit',
      second:   '2-digit',
    }) + ' (UTC-4 Bolivia)';

    const web3Rows = [
      ['Fecha y Hora',      fechaFormateada],
      ['Tipo de Operación', data.tipoOperacion],
      ['Red Utilizada',     'Stellar Network'],
    ];

    web3Rows.forEach(([label, valor]) => {
      const rowY = doc.y;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR_GRAY)
        .text(`${label}:`, marginL, rowY, { width: LABEL_W, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor('#222222')
        .text(valor, marginL + LABEL_W, rowY, { width: contentW - LABEL_W });
      doc.y = Math.max(doc.y, rowY + 16);
    });

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
    const explorerUrl = stellarExplorerTxUrl(data.txid);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR_ACCENT)
      .text(
        `Verificable en: ${explorerUrl}`,
        marginL,
        doc.y,
        { link: explorerUrl, underline: true },
      );

    doc.moveDown(0.5);

    // QR code de verificación Stellar — escanear para abrir en Stellar Expert
    if (qrBuffer && data.txid !== 'PENDIENTE') {
      const qrSize = 70;
      const qrX    = marginL;
      const qrY    = doc.y;
      doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor(COLOR_GRAY)
        .text(
          'Escanear para verificar en Stellar Explorer',
          qrX + qrSize + 8,
          qrY + (qrSize / 2) - 10,
          { width: contentW - qrSize - 8 },
        );
      doc.y = qrY + qrSize + 4;
    }

    doc.moveDown(0.5);
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
      ['Tipo de Cambio aplicado (BOB/USDC)',         `1 USDC = ${formatRate(data.tipoDeCambio)}`],
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

    // Texto legal configurable — env AV_FINANCE_LEGAL_FOOTER tiene máxima prioridad,
    // seguido del campo override en el DTO, con este texto como fallback compilado.
    const textoLegal = cleanEnvValue(process.env.AV_FINANCE_LEGAL_FOOTER)
      ?? cleanEnvValue(data.textoLegalFooter)
      ?? 'El presente Comprobante Oficial acredita la instrucción de pago transfronterizo ejecutada por '
       + 'AV Finance S.R.L. (NIT 706138025), Empresa de Tecnología Financiera y Proveedor de Servicios '
       + 'de Activos Virtuales (PSAV), bajo supervisión de la Autoridad de Supervisión del Sistema '
       + 'Financiero - ASFI (Trámite N° T-2201402987), conforme al Decreto Supremo N° 5384 de 7 de mayo '
       + 'de 2025. La operación fue ejecutada íntegramente por canales bancarios formales a través de una '
       + 'entidad financiera regulada por ASFI. Este documento constituye respaldo documental de la '
       + 'operación conforme a la Resolución Normativa de Directorio N° 102400000021 (Reglamento de '
       + 'Bancarización). La nota fiscal correspondiente a la comisión por servicio tecnológico será '
       + 'emitida por AV Finance S.R.L. conforme a la normativa del Servicio de Impuestos Nacionales '
       + '(SIN). Las operaciones sobre activos virtuales (USDC) son a riesgo del consumidor financiero, '
       + 'conforme al Art. 3°, Sección 4 del Reglamento para ETF (Circular ASFI/885/2025). El activo '
       + 'virtual USDC no constituye moneda de curso legal ni depósito bancario.';

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

    // Generar QR de verificación Stellar (best-effort: no falla el PDF si el QR falla)
    let qrBuffer = null;
    if (data.txid && data.txid !== 'PENDIENTE') {
      try {
        const explorerUrl = stellarExplorerTxUrl(data.txid);
        qrBuffer = await QRCode.toBuffer(explorerUrl, {
          type:   'png',
          width:  200,
          margin: 1,
          color:  { dark: '#1D3461', light: '#FFFFFF' },
        });
      } catch { /* QR opcional — no bloquea */ }
    }

    const buffer = await buildPDF(data, qrBuffer);

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
