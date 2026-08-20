/**
 * payoutController.js — Controlador de Off-Ramp y Liquidación
 *
 * Maneja el endpoint de liquidación manual del Corredor Bolivia (Escenario C).
 * Valida que la operación corresponda a AV Finance SRL antes de proceder.
 *
 * Flujo de processBoliviaManualPayout:
 *   1. Control de acceso: rol admin (la ruta ya aplica protect + requireAdmin)
 *   2. Buscar la transacción en BD y verificar estado 'in_transit'
 *   3. Validación Multi-Entidad → legalEntity = 'SRL' (jurisdicción Bolivia)
 *   4. Resolver el tipo de cambio server-side (override del cliente acotado)
 *   5. Reclamar la transacción de forma ATÓMICA (in_transit → completed)
 *   6. Recién entonces consumir el correlativo y emitir el Comprobante Oficial
 *   7. Persistir referencia del comprobante en BD
 *   8. Retornar el PDF al operador
 *
 * ⚠️ CONTROL PREVENTIVO (cerrado 2026-08-15): antes bastaba un JWT de cualquier
 * usuario SRL para liquidar una transacción ajena — se completaba la operación,
 * se quemaba un correlativo oficial y el PDF devuelto exponía el KYC del titular.
 * Hoy: rol admin (ruta + controlador), reclamo atómico del estado para que dos
 * llamadas concurrentes no emitan dos comprobantes, y tipo de cambio resuelto
 * desde la cotización bloqueada — el override manual queda acotado y auditado.
 *
 * SKILL activo: Compliance_Bolivia_Alyto
 * COMPLIANCE: Terminología prohibida ausente.
 */

import Transaction from '../models/Transaction.js';
import User        from '../models/User.js';
import { generateOfficialReceipt } from '../utils/pdfGenerator.js';
import { generarNumeroCorrelativo } from '../utils/correlativoService.js';
import { readDocumentNumber } from '../utils/clientDocument.js';
import { buildSrlComprobanteDTO } from '../utils/comprobanteDto.js';
import { ensureDek, isPiiEncryptionEnabled } from '../services/piiCrypto.js';
import { autoGenerateBusinessInvoice } from './businessInvoiceController.js';
import { uploadBuffer } from '../services/storageService.js';
import { getBOBRate } from '../services/exchangeRateService.js';
import { recordAdminAction } from '../services/adminAuditService.js';

/**
 * Desviación máxima tolerada (%) entre el `tipoCambioManual` que envía el
 * operador y la tasa de referencia server-side. Leído dentro de la función
 * (regla 21 de CLAUDE.md: nunca capturar env en el ámbito de módulo).
 */
export function maxManualRateDeviationPct() {
  const raw = process.env.PAYOUT_MANUAL_RATE_MAX_DEVIATION_PCT;
  // Una var vacía es "sin configurar", no 0 — `Number('')` es 0 y cerraría la
  // banda en silencio. Cualquier valor no numérico o negativo cae al default.
  if (raw === undefined || raw === null || String(raw).trim() === '') return 5;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5;
}

/**
 * Decide qué tasa BOB/USD se estampa en el Comprobante Oficial.
 * Lógica pura y testeable: la autoridad es la tasa bloqueada en la cotización;
 * el override manual solo se acepta dentro de una banda alrededor de la referencia.
 *
 * @param {object} p
 * @param {number|null|undefined} p.manualRate    — tipoCambioManual crudo del body
 * @param {number|null|undefined} p.lockedRate    — transaction.conversionRate.rate
 * @param {number|null|undefined} p.fallbackRate  — tasa de mercado (solo si no hay locked)
 * @param {number} p.maxDeviationPct
 * @returns {{ ok: true, rate: number, source: 'locked_quote'|'manual_override',
 *             referenceRate: number, deviationPct: number }
 *          | { ok: false, code: string, referenceRate: number|null, deviationPct: number|null }}
 */
export function resolveComprobanteRate({ manualRate, lockedRate, fallbackRate, maxDeviationPct }) {
  const locked   = Number(lockedRate);
  const hasLocked = Number.isFinite(locked) && locked > 0;

  // Sin override: manda la cotización bloqueada al despachar el payout.
  if (manualRate === undefined || manualRate === null || manualRate === '') {
    if (!hasLocked) return { ok: false, code: 'NO_RATE_AVAILABLE', referenceRate: null, deviationPct: null };
    return { ok: true, rate: locked, source: 'locked_quote', referenceRate: locked, deviationPct: 0 };
  }

  const manual = Number(manualRate);
  if (!Number.isFinite(manual) || manual <= 0) {
    return { ok: false, code: 'MANUAL_RATE_INVALID', referenceRate: hasLocked ? locked : null, deviationPct: null };
  }

  // Referencia: la tasa bloqueada; si la tx no la tiene, la tasa de mercado.
  const fallback  = Number(fallbackRate);
  const reference = hasLocked ? locked : (Number.isFinite(fallback) && fallback > 0 ? fallback : null);
  if (reference === null) {
    return { ok: false, code: 'NO_REFERENCE_RATE', referenceRate: null, deviationPct: null };
  }

  const deviationPct = Math.abs(manual - reference) / reference * 100;
  if (deviationPct > maxDeviationPct) {
    return { ok: false, code: 'MANUAL_RATE_OUT_OF_BOUNDS', referenceRate: reference, deviationPct };
  }

  return { ok: true, rate: manual, source: 'manual_override', referenceRate: reference, deviationPct };
}

// ─── POST /api/v1/payouts/bolivia/manual ────────────────────────────────────

/**
 * Procesa la liquidación manual del Corredor Bolivia (AV Finance SRL — Escenario C).
 *
 * Body esperado:
 * {
 *   "transactionId": "64abc...",    ← _id de Transaction en BD
 *   "tipoCambioManual": 6.98        ← Tipo de cambio BOB/USDC aplicado por el operador
 *                                      (opcional, por defecto usa tipoDeCambio simulado)
 * }
 *
 * Respuesta exitosa (200):
 *   → Content-Type: application/pdf
 *   → Attachment: comprobante_BOL-202503-XXXXXX_20250316.pdf
 *
 * Respuesta de error:
 *   → Content-Type: application/json
 *   → { success: false, error: '...' }
 */
export async function processBoliviaManualPayout(req, res) {
  const { transactionId, tipoCambioManual } = req.body;

  // ── 0. Control de acceso — defensa en profundidad ─────────────────────────
  // La ruta ya aplica protect + requireAdmin; revalidamos aquí para que un
  // remontaje futuro del router no reabra el agujero en silencio. Emitir un
  // Comprobante Oficial es una operación de back-office, nunca del titular.
  if (req.user?.role !== 'admin') {
    console.warn('[Alyto Payout Bolivia] REJECT: llamada sin rol admin.', {
      userId: req.user?._id?.toString(), role: req.user?.role, transactionId,
    });
    return res.status(403).json({
      success: false,
      error:   'Acceso denegado. La liquidación manual Bolivia requiere rol de administrador.',
    });
  }

  // ── 1. Validación de entrada ──────────────────────────────────────────────
  if (!transactionId) {
    return res.status(400).json({
      success: false,
      error:   'El campo transactionId es requerido.',
    });
  }

  // ── 2. Buscar la transacción en BD ────────────────────────────────────────
  let transaction;
  try {
    transaction = await Transaction.findById(transactionId);
  } catch {
    return res.status(400).json({
      success: false,
      error:   'transactionId inválido o con formato incorrecto.',
    });
  }

  if (!transaction) {
    return res.status(404).json({
      success: false,
      error:   'Transacción no encontrada.',
    });
  }

  // ── 3. Verificar estado previo: debe ser 'in_transit' ─────────────────────
  // El tránsito Stellar debe haberse completado antes de ejecutar el off-ramp manual.
  if (transaction.status !== 'in_transit') {
    return res.status(409).json({
      success:         false,
      error:           `La transacción no está en estado 'in_transit'. Estado actual: '${transaction.status}'.`,
      currentStatus:   transaction.status,
      requiredStatus:  'in_transit',
    });
  }

  // ── 3.b Un comprobante por operación ──────────────────────────────────────
  // Rechazo temprano y explícito del replay: revertir el estado a 'in_transit'
  // (posible vía PATCH /admin/transactions/:id/status) no debe habilitar la
  // emisión de un segundo Comprobante Oficial. El guard duro está en el reclamo
  // atómico del paso 7; esto solo da un error legible antes de trabajar de más.
  if (transaction.boliviaCompliance?.numeroComprobante) {
    return res.status(409).json({
      success:           false,
      error:             `La transacción ya tiene un Comprobante Oficial emitido (${transaction.boliviaCompliance.numeroComprobante}). No se emite un segundo correlativo para la misma operación.`,
      code:              'COMPROBANTE_ALREADY_ISSUED',
      numeroComprobante: transaction.boliviaCompliance.numeroComprobante,
    });
  }

  // ── 4. VALIDACIÓN MULTI-ENTIDAD ───────────────────────────────────────────
  // El Corredor Bolivia opera exclusivamente bajo AV Finance SRL.
  // Transacciones de LLC o SpA no pueden liquidarse por este endpoint.
  if (transaction.legalEntity !== 'SRL') {
    return res.status(403).json({
      success:        false,
      error:          'La liquidación manual Bolivia solo está disponible para operaciones de la jurisdicción SRL.',
      currentEntity:  transaction.legalEntity,
      requiredEntity: 'SRL',
    });
  }

  // Doble chequeo: el país de destino debe ser Bolivia
  if (transaction.destinationCountry && transaction.destinationCountry !== 'BO') {
    return res.status(403).json({
      success:            false,
      error:              'El país de destino de esta transacción no corresponde al Corredor Bolivia.',
      destinationCountry: transaction.destinationCountry,
    });
  }

  // ── 5. Cargar usuario para datos KYC del comprobante ─────────────────────
  // +identityDocument.numberCiphertext (select:false) para descifrar el CI real.
  let user;
  try {
    user = await User.findById(transaction.userId).select('+identityDocument.numberCiphertext').lean();
    if (isPiiEncryptionEnabled()) { try { await ensureDek(); } catch { /* comprobante cae a "En verificación" */ } }
  } catch (err) {
    console.error('[Alyto Payout Bolivia] Error cargando usuario:', {
      transactionId,
      error: err.message,
    });
    return res.status(500).json({
      success: false,
      error:   'Error al cargar datos del cliente. Intenta nuevamente.',
    });
  }

  if (!user) {
    return res.status(404).json({
      success: false,
      error:   'Usuario asociado a la transacción no encontrado.',
    });
  }

  // ── 6. Resolver el tipo de cambio SERVER-SIDE ─────────────────────────────
  // La autoridad es conversionRate.rate = BOB/USD bloqueada por
  // ipnController.dispatchPayout al despachar el payout (semántica consistente
  // desde fase 18B; el viejo Transaction.exchangeRate es ambiguo — ver
  // Transaction.js @deprecated). El `tipoCambioManual` del cliente ya NO se
  // acepta a ciegas: se estampa en un documento con valor regulatorio, así que
  // solo se admite dentro de una banda alrededor de la referencia y se audita.
  const lockedRate = transaction.conversionRate?.rate;
  let fallbackRate = null;
  if (tipoCambioManual != null && tipoCambioManual !== '' && !(lockedRate > 0)) {
    // Solo pagamos la latencia de la tasa de mercado si hay override y no hay
    // tasa bloqueada contra la cual compararlo.
    try { fallbackRate = await getBOBRate(); } catch { fallbackRate = null; }
  }

  const rateDecision = resolveComprobanteRate({
    manualRate:      tipoCambioManual,
    lockedRate,
    fallbackRate,
    maxDeviationPct: maxManualRateDeviationPct(),
  });

  if (!rateDecision.ok) {
    const detalle = {
      NO_RATE_AVAILABLE:        'No se pudo determinar tipo de cambio',
      NO_REFERENCE_RATE:        'No hay tasa de referencia para validar el tipo de cambio manual',
      MANUAL_RATE_INVALID:      'tipoCambioManual debe ser un número positivo',
      MANUAL_RATE_OUT_OF_BOUNDS: 'tipoCambioManual fuera de la banda permitida respecto a la tasa de referencia',
    }[rateDecision.code] ?? 'Tipo de cambio no válido';

    console.warn('[Alyto Payout Bolivia] REJECT: tipo de cambio no aceptado.', {
      transactionId, code: rateDecision.code,
      tipoCambioManual, lockedRate,
      referenceRate: rateDecision.referenceRate,
      deviationPct:  rateDecision.deviationPct,
      adminId:       req.user?._id?.toString(),
    });

    return res.status(422).json({
      success: false,
      error:   detalle,
      code:    rateDecision.code,
      detail:  `tx ${transaction.alytoTransactionId}: ` +
               `tipoCambioManual=${tipoCambioManual} ` +
               `conversionRate.rate=${lockedRate} ` +
               `| legalEntity=${transaction.legalEntity}`,
      referenceRate:   rateDecision.referenceRate,
      deviationPct:    rateDecision.deviationPct != null ? Number(rateDecision.deviationPct.toFixed(4)) : null,
      maxDeviationPct: maxManualRateDeviationPct(),
      hint: rateDecision.code === 'NO_RATE_AVAILABLE'
        ? 'Verificar que dispatchPayout haya seteado conversionRate antes de llamar a payout'
        : 'Usar la tasa bloqueada en la cotización, o corregir el override dentro de la banda permitida',
    });
  }

  const tipoCambioBob = rateDecision.rate;
  const ahora         = new Date();

  // ── 7. Reclamo ATÓMICO e IDEMPOTENTE de la transacción ───────────────────
  // El chequeo de estado del paso 3 es un check-then-act: dos llamadas
  // concurrentes lo pasaban ambas y emitían DOS comprobantes oficiales con dos
  // correlativos distintos para la misma operación. El filtro `status:
  // 'in_transit'` dentro del update hace que solo una gane.
  //
  // ⚠️ El filtro por estado solo serializa la concurrencia; NO alcanza para la
  // idempotencia. `PATCH /admin/transactions/:id/status` acepta 'in_transit'
  // como destino sin guard de transición, así que un admin puede revertir el
  // estado y re-liquidar: se quemaría un segundo correlativo y el
  // `numeroComprobante` anterior quedaría huérfano en la serie oficial
  // (sobrescrito, sin documento asociado). El guard real es el correlativo:
  // una transacción que YA tiene comprobante emitido no vuelve a emitir otro.
  let claimed;
  try {
    claimed = await Transaction.findOneAndUpdate(
      {
        _id:    transactionId,
        status: 'in_transit',
        $or: [
          { 'boliviaCompliance.numeroComprobante': { $exists: false } },
          { 'boliviaCompliance.numeroComprobante': null },
          { 'boliviaCompliance.numeroComprobante': '' },
        ],
      },
      {
        $set: {
          status:      'completed',
          completedAt: ahora,
          'boliviaCompliance.clientTaxId':        user.taxId ?? readDocumentNumber(user),
          'boliviaCompliance.amountBob':          transaction.originalAmount,
          'boliviaCompliance.exchangeRateBob':    tipoCambioBob,
          'boliviaCompliance.exchangeRateSource': rateDecision.source,
        },
        $push: {
          providersUsed: 'payout:anchorBolivia',
          paymentLegs: {
            stage:       'payout',
            provider:    'anchorBolivia',
            status:      'completed',
            completedAt: ahora,
          },
        },
      },
      { returnDocument: 'after' },
    );
  } catch (err) {
    console.error('[Alyto Payout Bolivia] Error actualizando transacción a completed:', {
      transactionId,
      error: err.message,
    });
    return res.status(500).json({
      success: false,
      error:   'Error al actualizar el estado de la transacción.',
    });
  }

  if (!claimed) {
    // Perdió el reclamo: otra llamada la liquidó, o ya tenía comprobante.
    // En ningún caso se consumió un correlativo.
    const actual = await Transaction.findById(transactionId)
      .select('status boliviaCompliance.numeroComprobante').lean();
    const yaEmitido = !!actual?.boliviaCompliance?.numeroComprobante;

    return res.status(409).json({
      success: false,
      error: yaEmitido
        ? `La transacción ya tiene un Comprobante Oficial emitido (${actual.boliviaCompliance.numeroComprobante}). No se emite un segundo correlativo para la misma operación.`
        : 'La transacción ya fue liquidada por otra operación en curso.',
      code:              yaEmitido ? 'COMPROBANTE_ALREADY_ISSUED' : 'ALREADY_SETTLED',
      numeroComprobante: yaEmitido ? actual.boliviaCompliance.numeroComprobante : undefined,
      currentStatus:     actual?.status,
      requiredStatus:    'in_transit',
    });
  }

  // El correlativo se consume DESPUÉS de ganar el reclamo: un fallo posterior ya
  // no quema un número de la serie oficial BOL-YYYYMM-NNNNNN.
  const numeroComprobante = await generarNumeroCorrelativo('BOL');
  try {
    await Transaction.findByIdAndUpdate(transactionId, {
      $set: {
        'boliviaCompliance.numeroComprobante':      numeroComprobante,
        'boliviaCompliance.comprobanteGeneratedAt': ahora,
      },
    });
  } catch (err) {
    // No crítico: el PDF se genera igual y el correlativo queda en el log.
    console.warn('[Alyto Payout Bolivia] No se pudo persistir el correlativo:', {
      transactionId, numeroComprobante, error: err.message,
    });
  }

  // Auditoría: un tipo de cambio distinto al bloqueado altera el monto del
  // Comprobante Oficial — queda registrado quién lo forzó y con qué desviación.
  if (rateDecision.source === 'manual_override') {
    await recordAdminAction({
      req,
      action:     'payout.bolivia.manual_rate_override',
      targetType: 'Transaction',
      targetId:   transactionId,
      before:     { exchangeRateBob: rateDecision.referenceRate, source: 'locked_quote' },
      after:      { exchangeRateBob: tipoCambioBob, source: 'manual_override' },
      metadata:   {
        alytoTransactionId: transaction.alytoTransactionId,
        numeroComprobante,
        deviationPct:       Number(rateDecision.deviationPct.toFixed(4)),
        maxDeviationPct:    maxManualRateDeviationPct(),
        usedMarketFallback: !(lockedRate > 0),
      },
    }).catch(() => {});   // fire-and-forget: recordAdminAction ya alerta a Sentry
  }

  // ── 8. Generar el Comprobante Oficial de Transacción (PDF) ────────────────
  // DTO desde la fuente única (utils/comprobanteDto.js). Antes se construía
  // acá a mano y leía la comisión de `feeBreakdown.alytoFee`, un sub-esquema
  // legacy que ningún path escribe → el comprobante salía con comisión 0 y el
  // total liquidado inflado. El campo canónico es `fees.totalDeducted`.
  const { dto: comprobanteDTO, clientDoc } = buildSrlComprobanteDTO({
    transaction,
    user,
    numeroComprobante,
    tipoCambioOverride: tipoCambioBob,   // ya validado contra la banda permitida
  });

  if (clientDoc.ciPending) {
    console.warn('[Comprobante] CI del cliente aún no capturado — se emite "En verificación":', {
      numeroComprobante, userId: user._id.toString(),
    });
  }

  const totalLiquidado = comprobanteDTO.totalLiquidado;

  let pdfBuffer, filename;
  try {
    ({ buffer: pdfBuffer, filename } = await generateOfficialReceipt(comprobanteDTO));
  } catch (err) {
    console.error('[Alyto Payout Bolivia] Error generando Comprobante PDF:', {
      transactionId,
      numeroComprobante,
      error: err.message,
    });
    // La transacción ya está COMPLETED — el PDF puede regenerarse bajo demanda
    return res.status(500).json({
      success:            false,
      error:              'Liquidación registrada, pero el comprobante PDF no pudo generarse. Contactar al equipo operativo.',
      alytoTransactionId: transaction.alytoTransactionId,
      numeroComprobante,
    });
  }

  // ── 9. Subir comprobante a storage (S3 / local fallback) y persistir URL ──
  try {
    const s3Key = `pdfs/bolivia/${numeroComprobante}_${filename}`
    const { url: pdfUrl, storage } = await uploadBuffer(pdfBuffer, s3Key, {
      contentType: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    })
    await Transaction.findByIdAndUpdate(transactionId, {
      $set: { 'boliviaCompliance.comprobantePdfUrl': pdfUrl },
    })
    console.info('[Alyto Payout Bolivia] PDF subido al storage.', {
      numeroComprobante, storage, key: s3Key,
    })
  } catch (err) {
    // No crítico — el PDF ya fue generado y se enviará al cliente
    console.warn('[Alyto Payout Bolivia] No se pudo persistir URL del comprobante:', {
      transactionId, error: err.message,
    })
  }

  console.info('[Alyto Payout Bolivia] Liquidación completada.', {
    transactionId:      transaction._id.toString(),
    alytoTransactionId: transaction.alytoTransactionId,
    numeroComprobante,
    totalLiquidadoBOB:  totalLiquidado,
    stellarTxId:        transaction.stellarTxId,
  });

  // ── 10. Auto-generar factura B2B si el usuario es Business ────────────────
  if (user.accountType === 'business' && user.businessProfileId) {
    // Recargar transacción fresca (con status: completed) para el generador B2B
    Transaction.findById(transactionId).then(freshTx => {
      if (freshTx) return autoGenerateBusinessInvoice(freshTx, user._id);
    }).catch(err => console.warn('[B2B Invoice] Auto-generation failed:', err.message));
  }

  // ── 11. Retornar el PDF al caller ────────────────────────────────────────
  res.setHeader('Content-Type',        'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length',      pdfBuffer.length);
  return res.status(200).send(pdfBuffer);
}
