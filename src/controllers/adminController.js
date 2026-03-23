/**
 * adminController.js — Panel de Administración Global Alyto V2.0
 *
 * Endpoints exclusivos para usuarios con role = 'admin'.
 * Protegidos con protect + checkAdmin en las rutas.
 *
 * getAllUsers             → Lista todos los usuarios con KYC y entidad legal.
 * getGlobalLedger        → Últimas 100 operaciones con populate del usuario origen.
 * listTransactions       → Backoffice Ledger: lista paginada + filtros + resumen.
 * getTransaction         → Detalle completo de una transacción (incluye ipnLog).
 * updateTransactionStatus → Actualización manual de status con auditoría en ipnLog.
 * listCorridors          → Lista todos los corredores (TransactionConfig).
 * updateCorridor         → Actualiza parámetros económicos de un corredor.
 */

import User              from '../models/User.js';
import Transaction       from '../models/Transaction.js';
import TransactionConfig from '../models/TransactionConfig.js';

// ─── getAllUsers ──────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/users
 *
 * Retorna todos los usuarios registrados ordenados por fecha de registro
 * descendente. Incluye legalEntity, kycStatus y campos de auditoría.
 *
 * Respuesta: { total: number, users: [...] }
 */
export async function getAllUsers(req, res) {
  try {
    const users = await User.find({})
      .select('firstName lastName email legalEntity kycStatus role isActive residenceCountry createdAt lastLoginAt')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      total: users.length,
      users,
    });

  } catch (err) {
    console.error('[Admin] Error en getAllUsers:', err.message);
    return res.status(500).json({ error: 'Error al obtener usuarios.' });
  }
}

// ─── getGlobalLedger ──────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/ledger
 *
 * Retorna las últimas 100 operaciones del sistema con el usuario
 * creador populado. Incluye la entidad legal que originó cada operación
 * (desnormalizada en el modelo Transaction para auditoría independiente).
 *
 * Respuesta: { total: number, transactions: [...] }
 */
export async function getGlobalLedger(req, res) {
  try {
    const transactions = await Transaction.find({})
      .select(
        'alytoTransactionId legalEntity operationType routingScenario ' +
        'originalAmount originCurrency digitalAsset digitalAssetAmount ' +
        'status stellarTxId providersUsed createdAt userId',
      )
      .populate('userId', 'firstName lastName email legalEntity')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({
      total: transactions.length,
      transactions,
    });

  } catch (err) {
    console.error('[Admin] Error en getGlobalLedger:', err.message);
    return res.status(500).json({ error: 'Error al obtener el libro mayor.' });
  }
}

// ─── BACKOFFICE LEDGER ────────────────────────────────────────────────────────

// Status válidos según el enum del modelo Transaction
const VALID_STATUSES = [
  'initiated', 'payin_pending', 'payin_confirmed', 'payin_completed',
  'processing', 'in_transit', 'payout_pending', 'payout_sent',
  'completed', 'failed', 'refunded',
];

// ─── listTransactions ─────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/transactions
 *
 * Lista paginada de transacciones con filtros opcionales y resumen estadístico.
 * El resumen (totalVolume, totalCompleted, etc.) aplica a TODA la selección
 * filtrada, no solo a la página actual — se calcula con una agregación única.
 *
 * Query params opcionales:
 *   status      — uno de los valores del enum Transaction.status
 *   corridorId  — slug del corredor (ej. "cl-bo-fintoc-anchorbolivia")
 *   entity      — 'LLC' | 'SpA' | 'SRL'
 *   startDate   — ISO 8601 (ej. "2026-01-01") — filtra createdAt >= startDate
 *   endDate     — ISO 8601 — filtra createdAt <= endDate (hasta fin del día)
 *   page        — número de página, default 1
 *   limit       — resultados por página, default 20, máximo 100
 */
export async function listTransactions(req, res) {
  // ── 1. Parsear y validar query params ─────────────────────────────────────
  const {
    status, entity, startDate, endDate,
    corridorId: corridorSlug,
  } = req.query;

  let page  = parseInt(req.query.page,  10) || 1;
  let limit = parseInt(req.query.limit, 10) || 20;
  if (page  < 1)   page  = 1;
  if (limit < 1)   limit = 1;
  if (limit > 100) limit = 100;

  // Validar status si se proporcionó
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error:          `Status inválido. Valores permitidos: ${VALID_STATUSES.join(', ')}.`,
      validStatuses:  VALID_STATUSES,
    });
  }

  // Validar entity si se proporcionó
  if (entity && !['LLC', 'SpA', 'SRL'].includes(entity)) {
    return res.status(400).json({ error: 'entity debe ser LLC, SpA o SRL.' });
  }

  // ── 2. Construir filtro de MongoDB ────────────────────────────────────────
  const filter = {};

  if (status)     filter.status      = status;
  if (entity)     filter.legalEntity = entity;

  // Rango de fechas sobre createdAt
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999); // incluir todo el día de endDate
      filter.createdAt.$lte = end;
    }
  }

  // Filtro por corredor: corridorId es un ObjectId en Transaction,
  // por lo que resolvemos el slug → _id antes de aplicar el filtro.
  if (corridorSlug) {
    try {
      const corridor = await TransactionConfig
        .findOne({ corridorId: corridorSlug.toLowerCase() })
        .select('_id')
        .lean();

      if (!corridor) {
        // Corredor no existe → devolver resultado vacío con paginación correcta
        return res.json({
          transactions: [],
          pagination:   { total: 0, page, limit, totalPages: 0 },
          summary:      { totalVolume: 0, totalCompleted: 0, totalFailed: 0, totalFees: 0 },
        });
      }

      filter.corridorId = corridor._id;
    } catch (err) {
      console.error('[Admin listTransactions] Error resolviendo corridorId:', err.message);
      return res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }

  // ── 3. Ejecutar en paralelo: agregación de resumen + consulta paginada ────
  try {
    const [summaryResult, transactions] = await Promise.all([
      // Agregación que calcula totales sobre TODA la selección filtrada
      Transaction.aggregate([
        { $match: filter },
        {
          $group: {
            _id:            null,
            total:          { $sum: 1 },
            totalVolume:    { $sum: '$originalAmount' },
            totalCompleted: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            totalFailed:    { $sum: { $cond: [{ $eq: ['$status', 'failed'] },    1, 0] } },
            totalFees:      { $sum: '$feeBreakdown.totalFee' },
          },
        },
      ]),

      // Consulta paginada con populate del usuario
      Transaction.find(filter)
        .populate('userId', 'email firstName lastName')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const agg   = summaryResult[0] ?? { total: 0, totalVolume: 0, totalCompleted: 0, totalFailed: 0, totalFees: 0 };
    const total = agg.total;

    return res.json({
      transactions,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      summary: {
        totalVolume:    agg.totalVolume    ?? 0,
        totalCompleted: agg.totalCompleted ?? 0,
        totalFailed:    agg.totalFailed    ?? 0,
        totalFees:      agg.totalFees      ?? 0,
      },
    });

  } catch (err) {
    console.error('[Admin listTransactions] Error:', err.message);
    return res.status(500).json({ error: 'Error al obtener transacciones.' });
  }
}

// ─── getTransaction ───────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/transactions/:transactionId
 *
 * Retorna el documento completo de una transacción, incluyendo ipnLog y todos
 * los campos internos. El userId se puebla con datos del usuario (sin password).
 *
 * Params:
 *   transactionId — alytoTransactionId (ej. "ALY-B-1710000000000-XYZ123")
 */
export async function getTransaction(req, res) {
  const { transactionId } = req.params;

  try {
    const transaction = await Transaction
      .findOne({ alytoTransactionId: transactionId })
      .populate('userId', 'email firstName lastName legalEntity kycStatus residenceCountry')
      .lean();

    if (!transaction) {
      return res.status(404).json({ error: 'Transacción no encontrada.' });
    }

    return res.json({ transaction });

  } catch (err) {
    console.error('[Admin getTransaction] Error:', { transactionId, error: err.message });
    return res.status(500).json({ error: 'Error al obtener la transacción.' });
  }
}

// ─── updateTransactionStatus ──────────────────────────────────────────────────

/**
 * PATCH /api/v1/admin/transactions/:transactionId/status
 *
 * Actualización manual del status de una transacción desde el backoffice.
 * Registra la intervención en ipnLog para trazabilidad de auditoría completa.
 *
 * Body:
 *   { status: String, note: String }   — ambos requeridos
 *
 * El registro en ipnLog usa:
 *   provider   = 'manual'
 *   eventType  = 'manual_status_update'
 *   rawPayload = { previousStatus, newStatus, note, adminId }
 */
export async function updateTransactionStatus(req, res) {
  const { transactionId } = req.params;
  const { status: newStatus, note } = req.body;
  const adminId = req.user._id.toString();

  // ── 1. Validar body ───────────────────────────────────────────────────────
  if (!newStatus || !note) {
    return res.status(400).json({ error: 'Los campos status y note son requeridos.' });
  }

  if (!VALID_STATUSES.includes(newStatus)) {
    return res.status(400).json({
      error:         `Status inválido. Valores permitidos: ${VALID_STATUSES.join(', ')}.`,
      validStatuses: VALID_STATUSES,
    });
  }

  if (typeof note !== 'string' || note.trim().length === 0) {
    return res.status(400).json({ error: 'note no puede estar vacío.' });
  }

  // ── 2. Buscar transacción ─────────────────────────────────────────────────
  let transaction;
  try {
    transaction = await Transaction.findOne({ alytoTransactionId: transactionId });
  } catch (err) {
    console.error('[Admin updateTransactionStatus] Error buscando transacción:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  if (!transaction) {
    return res.status(404).json({ error: 'Transacción no encontrada.' });
  }

  const previousStatus = transaction.status;

  // ── 3. Actualizar status y registrar en ipnLog ────────────────────────────
  transaction.status = newStatus;
  transaction.ipnLog.push({
    provider:   'manual',
    eventType:  'manual_status_update',
    status:     newStatus,
    rawPayload: {
      previousStatus,
      newStatus,
      note:    note.trim(),
      adminId,
    },
    receivedAt: new Date(),
  });

  try {
    await transaction.save();
  } catch (err) {
    console.error('[Admin updateTransactionStatus] Error guardando:', {
      transactionId,
      adminId,
      error: err.message,
    });
    return res.status(500).json({ error: 'Error al actualizar la transacción.' });
  }

  console.info('[Admin] Status actualizado manualmente:', {
    transactionId,
    previousStatus,
    newStatus,
    adminId,
  });

  return res.json({ transaction });
}

// ─── CORREDORES ───────────────────────────────────────────────────────────────

// Campos protegidos que no pueden modificarse vía este endpoint
const CORRIDOR_PROTECTED_FIELDS = new Set([
  'corridorId', '_id', '__v', 'createdAt', 'updatedAt',
]);

// ─── listCorridors ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/corridors
 *
 * Retorna todos los corredores de pago (activos e inactivos), ordenados
 * alfabéticamente por corridorId para facilitar la navegación en el backoffice.
 */
export async function listCorridors(req, res) {
  try {
    const corridors = await TransactionConfig
      .find({})
      .sort({ corridorId: 1 })
      .lean();

    return res.json({
      total: corridors.length,
      corridors,
    });

  } catch (err) {
    console.error('[Admin listCorridors] Error:', err.message);
    return res.status(500).json({ error: 'Error al obtener los corredores.' });
  }
}

// ─── updateCorridor ───────────────────────────────────────────────────────────

/**
 * PATCH /api/v1/admin/corridors/:corridorId
 *
 * Actualiza los parámetros económicos u operativos de un corredor.
 * El campo corridorId (slug) y los metadatos internos (_id, __v, timestamps)
 * son protegidos y se ignoran aunque vengan en el body.
 *
 * Campos típicamente actualizados desde el backoffice:
 *   alytoCSpread, fixedFee, isActive, profitRetentionPercent,
 *   payinFeePercent, payoutFeeFixed, minAmountOrigin, maxAmountOrigin
 *
 * Params:
 *   corridorId — slug del corredor (ej. "cl-bo-fintoc-anchorbolivia")
 */
export async function updateCorridor(req, res) {
  const { corridorId } = req.params;

  // ── 1. Construir objeto de actualización (sin campos protegidos) ──────────
  const updates = {};
  for (const [key, value] of Object.entries(req.body)) {
    if (!CORRIDOR_PROTECTED_FIELDS.has(key)) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No se proporcionaron campos válidos para actualizar.' });
  }

  // ── 2. Actualizar y retornar el documento actualizado ─────────────────────
  try {
    const corridor = await TransactionConfig.findOneAndUpdate(
      { corridorId: corridorId.toLowerCase() },
      { $set: updates },
      { new: true, runValidators: true },
    ).lean();

    if (!corridor) {
      return res.status(404).json({ error: 'Corredor no encontrado.' });
    }

    console.info('[Admin] Corredor actualizado:', {
      corridorId,
      updatedFields: Object.keys(updates),
      adminId: req.user._id.toString(),
    });

    return res.json({ corridor });

  } catch (err) {
    // Mongoose ValidationError — campos fuera de rango o tipo incorrecto
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[Admin updateCorridor] Error:', { corridorId, error: err.message });
    return res.status(500).json({ error: 'Error al actualizar el corredor.' });
  }
}
