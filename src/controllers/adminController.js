/**
 * adminController.js — Panel de Administración Global Alyto V2.0
 *
 * Endpoints exclusivos para usuarios con role = 'admin'.
 * Protegidos con protect + checkAdmin en las rutas.
 *
 * getAllUsers              → Lista todos los usuarios con KYC y entidad legal.
 * getGlobalLedger         → Últimas 100 operaciones con populate del usuario origen.
 * listTransactions        → Backoffice Ledger: lista paginada + filtros + resumen.
 * getTransaction          → Detalle completo de una transacción (incluye ipnLog).
 * updateTransactionStatus → Actualización manual de status con auditoría en ipnLog.
 * listCorridors           → Lista todos los corredores (TransactionConfig).
 * createCorridor          → Crea un corredor nuevo.
 * updateCorridor          → Actualiza parámetros económicos con changeLog.
 * deactivateCorridor      → Baja lógica (isActive: false + deletedAt).
 * getCorridorAnalytics    → Rentabilidad de un corredor en un periodo.
 * getGlobalAnalytics      → Analytics global: entidades, corredores, volumen.
 */

import User              from '../models/User.js';
import Transaction       from '../models/Transaction.js';
import TransactionConfig from '../models/TransactionConfig.js';
import { dispatchPayout } from './ipnController.js';
import { notify, NOTIFICATIONS } from '../services/notifications.js';
import { sendEmail, EMAILS }    from '../services/email.js';
import {
  getPrices,
  getWallets,
  getDeposits,
  getCryptoPrices,
  VITA_SENT_ONLY_COUNTRIES,
}                         from '../services/vitaWalletService.js';
import { getBOBRate }     from '../services/exchangeRateService.js';
import { calculateFintocFee } from '../utils/fintocFees.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeAsset(raw) {
  if (!raw) return 'USDC';
  const upper = raw.toString().toUpperCase().trim();
  if (['USDT', 'USDC', 'USD', 'XLM'].includes(upper)) return upper;
  return 'USDC'; // fallback seguro
}

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
  'pending', 'initiated', 'payin_pending', 'payin_confirmed', 'payin_completed',
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
      .populate('userId', 'email firstName lastName legalEntity kycStatus residenceCountry accountType')
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
  const { status: newStatus, note, bankReference } = req.body;
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

  // Si el admin confirma un payin manual: guardar confirmationDetails
  if (newStatus === 'payin_confirmed') {
    transaction.confirmationDetails = {
      confirmedBy:      req.user._id,
      confirmedAt:      new Date(),
      confirmationNote: note.trim(),
      bankReference:    bankReference?.trim() ?? null,
    };
  }

  transaction.ipnLog.push({
    provider:   'manual',
    eventType:  'manual_payin_confirmed',
    status:     newStatus,
    rawPayload: {
      previousStatus,
      newStatus,
      note:          note.trim(),
      adminId,
      bankReference: bankReference?.trim() ?? null,
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

  // ── Notificar al usuario que su pago fue recibido (payin manual confirmado) ─
  if (newStatus === 'payin_confirmed') {
    // Push + in-app notification
    notify(transaction.userId, NOTIFICATIONS.payinConfirmed(
      transaction.originalAmount, transaction.originCurrency,
    )).catch(err => console.error('[Admin] Error notify payin_confirmed:', err.message));

    // Email transaccional
    User.findById(transaction.userId).select('email firstName lastName').lean()
      .then(user => {
        if (user?.email) sendEmail(...EMAILS.paymentInitiated(user, transaction));
      })
      .catch(err => console.error('[Admin] Error email payin_confirmed:', err.message));
  }

  // ── Trigger automático de payout cuando el admin confirma un payin manual ─
  // Para corredores SRL Bolivia el payin es manual — el admin verifica la
  // transferencia bancaria y cambia el status a 'payin_confirmed'.
  // En ese momento se dispara automáticamente el payout a Vita.
  if (newStatus === 'payin_confirmed') {
    console.info('[Admin] Disparando dispatchPayout para payin manual confirmado:', {
      transactionId,
      legalEntity:  transaction.legalEntity,
      corridor:     transaction.corridorId?.toString(),
      destCountry:  transaction.destinationCountry,
      amount:       transaction.originalAmount,
      currency:     transaction.originCurrency,
    });
    dispatchPayout(transaction).catch(async (err) => {
      console.error('[Admin] ❌ Error en dispatchPayout tras confirmación manual:', {
        transactionId,
        error:  err.message,
        stack:  err.stack?.split('\n').slice(0, 3).join(' | '),
      });
      // Enviar alerta admin por email — el payout falló después de confirmar payin
      try {
        const adminEmail = process.env.ADMIN_EMAIL ?? process.env.SENDGRID_ADMIN_EMAIL;
        if (adminEmail) {
          await sendEmail(
            adminEmail,
            process.env.SENDGRID_TEMPLATE_ADMIN_BOLIVIA ?? process.env.SENDGRID_TEMPLATE_FAILED,
            {
              transactionId,
              originAmount:   `${transaction.originalAmount} ${transaction.originCurrency}`,
              destinationCountry: transaction.destinationCountry,
              error:          err.message,
              createdAt:      new Date().toISOString(),
              ledgerUrl:      `${process.env.FRONTEND_URL ?? ''}/admin/transactions`,
              userName:       'ALERTA: Payout falló tras confirmación manual',
            },
          );
        }
      } catch (emailErr) {
        console.error('[Admin] Error enviando alerta admin de payout fallido:', emailErr.message);
      }
    });
  }

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

// ─── setCorridorRate ──────────────────────────────────────────────────────────

/**
 * PATCH /api/v1/admin/corridors/:corridorId/rate
 *
 * Actualiza la tasa de cambio manual (BOB/USDC) de un corredor SRL Bolivia.
 * Solo aplica a corredores con payinMethod: 'manual'.
 *
 * La tasa expresa cuántas unidades de originCurrency equivalen a 1 USDC.
 * Ejemplo: manualExchangeRate: 6.96 → 1 USDC = 6.96 BOB (tasa ASFI)
 *
 * Esta tasa es la fuente de verdad para:
 *   getQuote:      netBOB / manualExchangeRate = USDC en tránsito
 *   dispatchPayout: misma conversión, USDC se envía a Vita/OwlPay como USD
 *
 * Exige nota descriptiva obligatoria (mín. 10 chars) para auditoría.
 * Registra el cambio en corridor.changeLog con el campo `note`.
 *
 * Body: { manualExchangeRate: number, note: string }
 */
export async function setCorridorRate(req, res) {
  const { corridorId }                      = req.params;
  const { manualExchangeRate, note }        = req.body;
  const adminId                             = req.user._id;

  // ── 1. Validar entrada ────────────────────────────────────────────────────
  const rate = Number(manualExchangeRate);
  if (!isFinite(rate) || rate <= 0) {
    return res.status(400).json({
      error: 'manualExchangeRate debe ser un número positivo. Ejemplo: 6.96 (1 USDC = 6.96 BOB).',
    });
  }
  if (!note || note.trim().length < 10) {
    return res.status(400).json({
      error: 'Se requiere una nota descriptiva del ajuste (mín. 10 caracteres). Ej: "Tasa ASFI 24/03/2026".',
    });
  }

  // ── 2. Buscar corredor ────────────────────────────────────────────────────
  let corridor;
  try {
    corridor = await TransactionConfig.findOne({ corridorId: corridorId.toLowerCase() });
  } catch (err) {
    console.error('[Admin setCorridorRate] Error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  if (!corridor) {
    return res.status(404).json({ error: `Corredor '${corridorId}' no encontrado.` });
  }

  if (corridor.payinMethod !== 'manual') {
    return res.status(400).json({
      error:        `setCorridorRate solo aplica a corredores manuales (payinMethod: 'manual'). Este corredor usa '${corridor.payinMethod}'.`,
      payinMethod:  corridor.payinMethod,
      corridorId:   corridor.corridorId,
    });
  }

  // ── 3. Actualizar tasa con registro en changeLog ──────────────────────────
  const oldRate = corridor.manualExchangeRate ?? 0;
  const now     = new Date();

  corridor.manualExchangeRate = rate;
  corridor.changeLog.push({
    field:     'manualExchangeRate',
    oldValue:  oldRate,
    newValue:  rate,
    changedBy: adminId,
    changedAt: now,
    note:      note.trim(),
  });

  try {
    await corridor.save();
  } catch (err) {
    console.error('[Admin setCorridorRate] Error guardando:', { corridorId, error: err.message });
    return res.status(500).json({ error: 'Error al guardar la tasa.' });
  }

  console.info('[Admin] Tasa BOB/USDC actualizada:', {
    corridorId,
    oldRate,
    newRate:  rate,
    adminId:  adminId.toString(),
    note:     note.trim(),
  });

  return res.json({
    corridorId:         corridor.corridorId,
    originCurrency:     corridor.originCurrency,
    manualExchangeRate: rate,
    rateLabel:          `1 USDC = ${rate} ${corridor.originCurrency}`,
    previousRate:       oldRate,
    changedAt:          now,
    note:               note.trim(),
  });
}

// ─── createCorridor ───────────────────────────────────────────────────────────

/**
 * POST /api/v1/admin/corridors
 *
 * Crea un corredor nuevo. Valida que corridorId no exista previamente.
 * Body: todos los campos requeridos de TransactionConfig.
 */
export async function createCorridor(req, res) {
  const { corridorId } = req.body;

  if (!corridorId) {
    return res.status(400).json({ error: 'El campo corridorId es requerido.' });
  }

  try {
    const exists = await TransactionConfig.findOne({ corridorId: corridorId.toLowerCase() }).lean();
    if (exists) {
      return res.status(409).json({ error: `Ya existe un corredor con corridorId "${corridorId}".` });
    }

    const corridor = await TransactionConfig.create({
      ...req.body,
      corridorId: corridorId.toLowerCase(),
    });

    console.info('[Admin] Corredor creado:', {
      corridorId: corridor.corridorId,
      adminId: req.user._id.toString(),
    });

    return res.status(201).json({ corridor });

  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === 11000) {
      return res.status(409).json({ error: `Ya existe un corredor con corridorId "${corridorId}".` });
    }
    console.error('[Admin createCorridor] Error:', err.message);
    return res.status(500).json({ error: 'Error al crear el corredor.' });
  }
}

// ─── updateCorridor ───────────────────────────────────────────────────────────

/**
 * PATCH /api/v1/admin/corridors/:corridorId
 *
 * Actualiza los parámetros económicos u operativos de un corredor.
 * Registra cada campo modificado en changeLog con el valor anterior y nuevo.
 *
 * Params:
 *   corridorId — slug del corredor (ej. "cl-bo-fintoc-anchorbolivia")
 */
export async function updateCorridor(req, res) {
  const { corridorId } = req.params;
  const adminId = req.user._id;

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

  // ── 2. Cargar el documento actual para registrar oldValues en changeLog ───
  let corridor;
  try {
    corridor = await TransactionConfig.findOne({ corridorId: corridorId.toLowerCase() });
  } catch (err) {
    console.error('[Admin updateCorridor] Error buscando corredor:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  if (!corridor) {
    return res.status(404).json({ error: 'Corredor no encontrado.' });
  }

  const oldValues = corridor.toObject();

  // ── 3. Aplicar cambios y registrar en changeLog ───────────────────────────
  const now = new Date();
  for (const [field, newValue] of Object.entries(updates)) {
    if (String(oldValues[field]) !== String(newValue)) {
      corridor.changeLog.push({
        field,
        oldValue:  oldValues[field],
        newValue,
        changedBy: adminId,
        changedAt: now,
      });
    }
    corridor[field] = newValue;
  }

  // ── 4. Guardar con validación ─────────────────────────────────────────────
  try {
    await corridor.save();
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[Admin updateCorridor] Error guardando:', { corridorId, error: err.message });
    return res.status(500).json({ error: 'Error al actualizar el corredor.' });
  }

  console.info('[Admin] Corredor actualizado:', {
    corridorId,
    updatedFields: Object.keys(updates),
    adminId: adminId.toString(),
  });

  return res.json({ corridor });
}

// ─── deactivateCorridor ───────────────────────────────────────────────────────

/**
 * DELETE /api/v1/admin/corridors/:corridorId
 *
 * Baja lógica: marca isActive: false y registra deletedAt.
 * No elimina el documento físicamente para preservar historial.
 */
export async function deactivateCorridor(req, res) {
  const { corridorId } = req.params;
  const adminId = req.user._id;

  try {
    const corridor = await TransactionConfig.findOne({ corridorId: corridorId.toLowerCase() });

    if (!corridor) {
      return res.status(404).json({ error: 'Corredor no encontrado.' });
    }

    if (!corridor.isActive) {
      return res.status(400).json({ error: 'El corredor ya está desactivado.' });
    }

    corridor.isActive  = false;
    corridor.deletedAt = new Date();
    corridor.changeLog.push({
      field:     'isActive',
      oldValue:  true,
      newValue:  false,
      changedBy: adminId,
      changedAt: new Date(),
    });

    await corridor.save();

    console.info('[Admin] Corredor desactivado:', {
      corridorId,
      adminId: adminId.toString(),
    });

    return res.json({ message: 'Corredor desactivado.', corridorId: corridor.corridorId });

  } catch (err) {
    console.error('[Admin deactivateCorridor] Error:', err.message);
    return res.status(500).json({ error: 'Error al desactivar el corredor.' });
  }
}

// ─── getCorridorAnalytics ─────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/corridors/:corridorId/analytics
 *
 * Rentabilidad de un corredor en el periodo indicado.
 * Query params: startDate, endDate (ISO)
 */
export async function getCorridorAnalytics(req, res) {
  const { corridorId } = req.params;
  const { startDate, endDate } = req.query;

  try {
    const corridor = await TransactionConfig
      .findOne({ corridorId: corridorId.toLowerCase() })
      .lean();

    if (!corridor) {
      return res.status(404).json({ error: 'Corredor no encontrado.' });
    }

    const matchFilter = { corridorId: corridor._id };
    if (startDate || endDate) {
      matchFilter.createdAt = {};
      if (startDate) matchFilter.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setUTCHours(23, 59, 59, 999);
        matchFilter.createdAt.$lte = end;
      }
    }

    const [result] = await Transaction.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id:                     null,
          totalTransactions:       { $sum: 1 },
          completedTransactions:   { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          totalOriginAmount:       { $sum: '$originalAmount' },
          totalDestinationAmount:  { $sum: '$destinationAmount' },
          totalSpread:             { $sum: '$fees.alytoCSpread' },
          totalFixedFees:          { $sum: '$fees.fixedFee' },
          totalProfitRetention:    { $sum: '$fees.profitRetention' },
          totalRevenue:            {
            $sum: {
              $add: [
                { $ifNull: ['$fees.alytoCSpread',    0] },
                { $ifNull: ['$fees.fixedFee',         0] },
                { $ifNull: ['$fees.profitRetention',  0] },
              ],
            },
          },
        },
      },
    ]);

    const d = result ?? {
      totalTransactions: 0, completedTransactions: 0,
      totalOriginAmount: 0, totalDestinationAmount: 0,
      totalSpread: 0, totalFixedFees: 0, totalProfitRetention: 0, totalRevenue: 0,
    };

    const avgTx      = d.completedTransactions > 0 ? d.totalOriginAmount / d.completedTransactions : 0;
    const avgRevenue = d.completedTransactions > 0 ? d.totalRevenue / d.completedTransactions : 0;
    const spreadPct  = d.totalOriginAmount > 0 ? (d.totalRevenue / d.totalOriginAmount) * 100 : 0;

    return res.json({
      corridorId:  corridor.corridorId,
      period:      { startDate: startDate ?? null, endDate: endDate ?? null },
      volume: {
        totalTransactions:      d.totalTransactions,
        completedTransactions:  d.completedTransactions,
        totalOriginAmount:      d.totalOriginAmount,
        totalDestinationAmount: d.totalDestinationAmount,
      },
      revenue: {
        totalSpread:           d.totalSpread,
        totalFixedFees:        d.totalFixedFees,
        totalProfitRetention:  d.totalProfitRetention,
        totalRevenue:          d.totalRevenue,
      },
      averages: {
        avgTransactionAmount:      Math.round(avgTx),
        avgRevenuePerTransaction:  Math.round(avgRevenue),
        spreadEffectivePercent:    parseFloat(spreadPct.toFixed(2)),
      },
    });

  } catch (err) {
    console.error('[Admin getCorridorAnalytics] Error:', err.message);
    return res.status(500).json({ error: 'Error al obtener analytics del corredor.' });
  }
}

// ─── getGlobalAnalytics ───────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/analytics
 *
 * Analytics global: volumen total, revenue, desglose por entidad y corredor.
 * Query params: startDate, endDate (ISO)
 */
export async function getGlobalAnalytics(req, res) {
  const { startDate, endDate } = req.query;

  const dateFilter = {};
  if (startDate || endDate) {
    dateFilter.createdAt = {};
    if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);
      dateFilter.createdAt.$lte = end;
    }
  }

  try {
    const [globalResult, byEntityResult, byCorridorResult] = await Promise.all([

      // ── Global totals ────────────────────────────────────────────────────
      Transaction.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id:                  null,
            totalTransactions:    { $sum: 1 },
            completedTransactions:{ $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            failedTransactions:   { $sum: { $cond: [{ $eq: ['$status', 'failed'] },    1, 0] } },
            totalVolumeCLP:       { $sum: '$originalAmount' },
            totalRevenueCLP: {
              $sum: {
                $add: [
                  { $ifNull: ['$fees.alytoCSpread',   0] },
                  { $ifNull: ['$fees.fixedFee',        0] },
                  { $ifNull: ['$fees.profitRetention', 0] },
                ],
              },
            },
          },
        },
      ]),

      // ── By entity ────────────────────────────────────────────────────────
      Transaction.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id:          '$legalEntity',
            transactions: { $sum: 1 },
            volume:       { $sum: '$originalAmount' },
            revenue: {
              $sum: {
                $add: [
                  { $ifNull: ['$fees.alytoCSpread',   0] },
                  { $ifNull: ['$fees.fixedFee',        0] },
                  { $ifNull: ['$fees.profitRetention', 0] },
                ],
              },
            },
          },
        },
      ]),

      // ── By corridor ──────────────────────────────────────────────────────
      Transaction.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id:          '$corridorId',
            transactions: { $sum: 1 },
            volume:       { $sum: '$originalAmount' },
            revenue: {
              $sum: {
                $add: [
                  { $ifNull: ['$fees.alytoCSpread',   0] },
                  { $ifNull: ['$fees.fixedFee',        0] },
                  { $ifNull: ['$fees.profitRetention', 0] },
                ],
              },
            },
          },
        },
        { $sort: { volume: -1 } },
      ]),
    ]);

    // ── Resolver corridorId ObjectId → slug ──────────────────────────────
    const corridorIds = byCorridorResult
      .map(r => r._id)
      .filter(Boolean);

    const corridorDocs = await TransactionConfig
      .find({ _id: { $in: corridorIds } })
      .select('_id corridorId')
      .lean();

    const corridorSlugMap = {};
    for (const doc of corridorDocs) {
      corridorSlugMap[doc._id.toString()] = doc.corridorId;
    }

    // ── Construir respuesta ───────────────────────────────────────────────
    const g = globalResult[0] ?? {
      totalTransactions: 0, completedTransactions: 0, failedTransactions: 0,
      totalVolumeCLP: 0, totalRevenueCLP: 0,
    };

    const avgRevenuePct = g.totalVolumeCLP > 0
      ? parseFloat(((g.totalRevenueCLP / g.totalVolumeCLP) * 100).toFixed(2))
      : 0;

    // Construir mapa por entidad
    const byEntity = { SpA: null, LLC: null, SRL: null };
    for (const row of byEntityResult) {
      if (row._id) byEntity[row._id] = {
        transactions: row.transactions,
        volume:       row.volume,
        revenue:      row.revenue,
      };
    }
    for (const entity of ['SpA', 'LLC', 'SRL']) {
      if (!byEntity[entity]) byEntity[entity] = { transactions: 0, volume: 0, revenue: 0 };
    }

    const byCorridor = byCorridorResult.map(row => ({
      corridorId:      corridorSlugMap[row._id?.toString()] ?? row._id?.toString() ?? 'unknown',
      transactions:    row.transactions,
      volume:          row.volume,
      revenue:         row.revenue,
      revenuePercent:  row.volume > 0
        ? parseFloat(((row.revenue / row.volume) * 100).toFixed(2))
        : 0,
    }));

    return res.json({
      period: { startDate: startDate ?? null, endDate: endDate ?? null },
      global: {
        totalTransactions:     g.totalTransactions,
        completedTransactions: g.completedTransactions,
        failedTransactions:    g.failedTransactions,
        totalVolumeCLP:        g.totalVolumeCLP,
        totalRevenueCLP:       g.totalRevenueCLP,
        avgRevenuePercent:     avgRevenuePct,
      },
      byEntity,
      byCorridor,
      topCorridors: byCorridor.slice(0, 3),
    });

  } catch (err) {
    console.error('[Admin getGlobalAnalytics] Error:', err.message);
    return res.status(500).json({ error: 'Error al obtener analytics globales.' });
  }
}

// ─── getTransactionComprobante ────────────────────────────────────────────────

/**
 * GET /api/v1/admin/transactions/:transactionId/comprobante
 *
 * Retorna el comprobante de pago subido por el usuario, como base64.
 * Solo disponible para transacciones con paymentProof guardado.
 *
 * Requiere: protect + checkAdmin
 */
export async function getTransactionComprobante(req, res) {
  const { transactionId } = req.params;

  let transaction;
  try {
    transaction = await Transaction.findOne({ alytoTransactionId: transactionId })
      .select('alytoTransactionId paymentProof originalAmount originCurrency status userId')
      .populate('userId', 'firstName lastName email')
      .lean();
  } catch (err) {
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  if (!transaction) {
    return res.status(404).json({ error: 'Transacción no encontrada.' });
  }

  if (!transaction.paymentProof?.data) {
    return res.status(404).json({ error: 'Esta transacción no tiene comprobante subido.' });
  }

  return res.status(200).json({
    base64:     transaction.paymentProof.data,
    mimeType:   transaction.paymentProof.mimetype,
    filename:   transaction.paymentProof.filename,
    size:       transaction.paymentProof.size,
    uploadedAt: transaction.paymentProof.uploadedAt,
  });
}

// ─── getCorridorRates ────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/corridors/rates
 *
 * Muestra todos los corredores activos con la tasa en tiempo real a la que
 * se enviaría, fees desglosados y monto estimado para un envío de referencia.
 *
 * Query params:
 *   referenceAmount {number} — monto de referencia (default: 100000)
 *
 * Requiere: protect + checkAdmin
 */
export async function getCorridorRates(req, res) {
  const referenceAmount = Number(req.query.referenceAmount) || 100000;
  const round2 = n => Math.round(n * 100) / 100;

  let corridors;
  try {
    corridors = await TransactionConfig.find({ isActive: true })
      .sort({ corridorId: 1 })
      .lean();
  } catch (err) {
    console.error('[Admin getCorridorRates] Error BD:', err.message);
    return res.status(500).json({ error: 'Error al obtener los corredores.' });
  }

  // Una sola llamada a Vita para obtener todas las tasas
  let vitaPrices = null;
  try {
    vitaPrices = await getPrices();
  } catch (err) {
    console.warn('[Admin getCorridorRates] Vita /prices no disponible:', err.message);
  }

  const BOB_USD_RATE       = await getBOBRate();
  const vitaAttrsWithdrawal = vitaPrices?.withdrawal?.prices?.attributes ?? null;
  const vitaAttrsSent       = vitaPrices?.vita_sent?.prices?.attributes  ?? null;

  const result = corridors.map((c) => {
    const amount = referenceAmount;

    // Para GT/SV/ES/PL usar vita_sent prices; para el resto, withdrawal prices.
    const destUpper = (c.destinationCountry ?? '').toUpperCase();
    const vitaAttrs = VITA_SENT_ONLY_COUNTRIES.has(destUpper)
      ? (vitaAttrsSent ?? vitaAttrsWithdrawal)
      : vitaAttrsWithdrawal;

    // ── Calcular payinFee ─────────────────────────────────────────────────
    let payinFee = 0;
    let payinFeeDetail = null;
    if (c.payinMethod === 'fintoc' && c.fintocConfig?.ufValue) {
      const fintocResult = calculateFintocFee(amount, c.fintocConfig);
      payinFee = fintocResult.fixedFee;
      payinFeeDetail = {
        type: 'fintoc_uf',
        ufValue: fintocResult.ufValue,
        tier: fintocResult.tier,
        tierRate: fintocResult.tierRate,
        fixedFeeCLP: fintocResult.fixedFee,
        effectivePercent: round2(fintocResult.percentage),
      };
    } else if (c.payinMethod === 'manual') {
      payinFee = 0;
      payinFeeDetail = { type: 'manual', fixedFee: 0, note: 'Sin fee de payin' };
    } else {
      payinFee = amount * ((c.payinFeePercent ?? 0) / 100);
      payinFeeDetail = { type: 'percentage', percent: c.payinFeePercent ?? 0 };
    }

    const alytoCSpread    = amount * ((c.alytoCSpread ?? 0) / 100);
    const fixedFee        = c.fixedFee ?? 0;
    const profitRetention = amount * ((c.profitRetentionPercent ?? 0) / 100);
    const totalDeducted     = round2(payinFee + alytoCSpread + fixedFee);
    const totalDeductedReal = round2(payinFee + alytoCSpread + fixedFee + profitRetention);
    const netAmount         = round2(amount - totalDeductedReal);

    // ── Calcular tasa y monto destino ─────────────────────────────────────
    let effectiveRate      = null;
    let destinationAmount  = null;
    let rateSource         = null;
    let rateBreakdown      = null;

    if (vitaAttrs) {
      const destKey = c.destinationCountry.toLowerCase();

      if (destKey === 'bo' && c.originCurrency === 'CLP') {
        // CLP→BOB: tasa compuesta via Vita CLP→USD × BOB_USD_RATE
        const clpToUsd = Number(vitaAttrs.clp_sell?.['us'] ?? NaN);
        if (isFinite(clpToUsd) && clpToUsd > 0) {
          effectiveRate = round2(clpToUsd * BOB_USD_RATE * 1000000) / 1000000;
          const payoutFee = c.payoutFeeFixed ?? 0;
          destinationAmount = round2((netAmount * effectiveRate) - payoutFee);
          rateSource = 'vita_clp_usd × bob_usd_rate';
          rateBreakdown = {
            clpToUsd:    round2(clpToUsd * 1000000) / 1000000,
            bobUsdRate:  BOB_USD_RATE,
            composite:   effectiveRate,
          };
        }
      } else if (c.originCurrency === 'CLP') {
        // CLP→destino: tasa directa de Vita
        const rate = Number(vitaAttrs.clp_sell?.[destKey] ?? NaN);
        if (isFinite(rate) && rate > 0) {
          effectiveRate = rate;
          const vitaFixedCost = Number(vitaAttrs.fixed_cost?.[destKey] ?? 0);
          const payoutFee = vitaFixedCost > 0 ? vitaFixedCost : (c.payoutFeeFixed ?? 0);
          destinationAmount = round2((netAmount * effectiveRate) - payoutFee);
          rateSource = 'vita_clp_sell';
          rateBreakdown = { clpToDestRate: rate, payoutFee };
        }
      } else if (c.originCurrency === 'BOB') {
        // BOB→destino: BOB→USDC (tasa admin) → USDC→destino (tasa Vita)
        const bobPerUsdc = (c.manualExchangeRate && c.manualExchangeRate > 0)
          ? c.manualExchangeRate
          : BOB_USD_RATE;
        const usdcTransit = round2(netAmount / bobPerUsdc);

        // Tasa USDC→destino via cross-rate
        const clpToDest = Number(vitaAttrs.clp_sell?.[destKey] ?? NaN);
        const clpToUsd  = Number(vitaAttrs.clp_sell?.['us'] ?? NaN);
        if (isFinite(clpToDest) && isFinite(clpToUsd) && clpToUsd > 0) {
          const usdToDestRate = clpToDest / clpToUsd;
          const vitaFixedCost = Number(vitaAttrs.fixed_cost?.[destKey] ?? 0);
          const payoutFee = vitaFixedCost > 0 ? vitaFixedCost : (c.payoutFeeFixed ?? 0);
          destinationAmount = round2((usdcTransit * usdToDestRate) - payoutFee);
          effectiveRate = round2((destinationAmount / amount) * 1000000) / 1000000;
          rateSource = 'bob_admin_rate × vita_usd_dest';
          rateBreakdown = {
            bobPerUsdc,
            usdcTransit,
            usdToDestRate: round2(usdToDestRate * 100) / 100,
            payoutFee,
          };
        }
      }
    }

    return {
      corridorId:          c.corridorId,
      originCountry:       c.originCountry,
      destinationCountry:  c.destinationCountry,
      originCurrency:      c.originCurrency,
      destinationCurrency: c.destinationCurrency,
      payinMethod:         c.payinMethod,
      payoutMethod:        c.payoutMethod,
      legalEntity:         c.legalEntity,
      isActive:            c.isActive,
      // ── Fees desglosados ───────────────────────────────────────────────
      fees: {
        payinFee:          round2(payinFee),
        payinFeeDetail,
        alytoCSpread:      round2(alytoCSpread),
        alytoCSpreadPct:   c.alytoCSpread,
        fixedFee:          round2(fixedFee),
        profitRetention:   round2(profitRetention),
        profitRetentionPct: c.profitRetentionPercent,
        totalDeducted,
        totalDeductedReal,
      },
      // ── Tasa en tiempo real ────────────────────────────────────────────
      liveRate: {
        effectiveRate,
        rateSource,
        rateBreakdown,
        referenceAmount: amount,
        netAmountAfterFees: netAmount,
        estimatedDestinationAmount: destinationAmount,
        currency: c.destinationCurrency,
      },
      // ── Config del corredor ────────────────────────────────────────────
      config: {
        manualExchangeRate: c.manualExchangeRate,
        minAmountOrigin:    c.minAmountOrigin,
        maxAmountOrigin:    c.maxAmountOrigin,
        fintocConfig:       c.fintocConfig,
        fallbackPayoutMethod: c.fallbackPayoutMethod,
      },
    };
  });

  return res.json({
    total:           result.length,
    referenceAmount,
    bobUsdRate:      BOB_USD_RATE,
    vitaAvailable:   !!vitaPrices,
    corridors:       result,
  });
}

// ─── vitaDiagnostic ───────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/vita/diagnostic
 *
 * Diagnóstico completo del estado de la cuenta Vita AV Finance SpA.
 * Consulta en paralelo: wallets, precios/cobertura, depósitos recientes,
 * precios cripto y pares de exchange disponibles.
 *
 * Útil para verificar:
 *  - Saldos activos y monedas habilitadas
 *  - Cobertura de países por tabla (clp_sell, usd_sell, usdt_sell, etc.)
 *  - Redes blockchain aceptadas para depósitos USDT/USDC
 *  - Pares de exchange disponibles para conversión interna
 */
export async function vitaDiagnostic(req, res) {
  const [walletsRes, pricesRes, depositsRes, cryptoPricesRes] =
    await Promise.allSettled([
      getWallets(),
      getPrices(),
      getDeposits(),
      getCryptoPrices(),
    ]);

  // ── Wallets ────────────────────────────────────────────────────────────────
  let wallets = null;
  let walletsError = null;
  if (walletsRes.status === 'fulfilled') {
    const raw = walletsRes.value?.data ?? walletsRes.value;
    wallets = (Array.isArray(raw?.wallets ?? raw) ? (raw?.wallets ?? raw) : [raw]).map((w) => ({
      uuid:      w.uuid,
      type:      w.type,
      isMaster:  w.attributes?.token === 'master',
      balances:  w.attributes?.balances ?? {},
      createdAt: w.attributes?.created_at,
    }));
  } else {
    walletsError = walletsRes.reason?.message ?? 'Error desconocido';
  }

  // ── Precios / Cobertura de países ──────────────────────────────────────────
  // Estructura real de Vita /prices:
  //   { withdrawal: { prices: { attributes: { clp_sell: {co:..}, fixed_cost: {..} } } },
  //     vita_sent:  { prices: { attributes: { clp_sell: {co:..., gt:..., sv:...} } } },
  //     clp: { withdrawal: { prices: { ... } } } }
  let coverage = null;
  let pricesError = null;
  if (pricesRes.status === 'fulfilled') {
    const raw = pricesRes.value?.data ?? pricesRes.value ?? {};

    // Extraer los attrs de cada sección relevante
    const sections = {
      withdrawal: raw?.withdrawal?.prices?.attributes,
      vita_sent:  raw?.vita_sent?.prices?.attributes,
    };

    coverage = {};
    for (const [section, attrs] of Object.entries(sections)) {
      if (!attrs) continue;
      const clpSell   = attrs.clp_sell   ?? {};
      const fixedCost = attrs.fixed_cost ?? {};
      const minAmount = attrs.min_amount ?? {};

      coverage[section] = Object.entries(clpSell).map(([code, rate]) => ({
        code,
        rate,
        fixedCost:  fixedCost[code] ?? null,
        minAmount:  minAmount[code] ?? null,
        vitaSentOnly: VITA_SENT_ONLY_COUNTRIES.has(code.toUpperCase()),
      }));
    }
  } else {
    pricesError = pricesRes.reason?.message ?? 'Error desconocido';
  }

  // ── Depósitos recientes ────────────────────────────────────────────────────
  let deposits = null;
  let depositsError = null;
  if (depositsRes.status === 'fulfilled') {
    const raw = depositsRes.value?.data ?? depositsRes.value;
    const list = Array.isArray(raw) ? raw : (raw?.deposits ?? []);
    deposits = list.slice(0, 10).map((d) => ({
      id:        d.id ?? d.uuid,
      asset:     normalizeAsset(d.currency ?? d.asset ?? 'USDC'),
      network:   d.network,
      amount:    d.amount,
      status:    d.status,
      createdAt: d.created_at,
    }));
  } else {
    depositsError = depositsRes.reason?.message ?? 'Error desconocido';
  }

  // ── Precios cripto y pares de exchange ─────────────────────────────────────
  let cryptoPrices = null;
  let cryptoError = null;
  if (cryptoPricesRes.status === 'fulfilled') {
    const raw = cryptoPricesRes.value?.data ?? cryptoPricesRes.value;
    cryptoPrices = Array.isArray(raw)
      ? raw.map((p) => ({
          pair:    p.pair ?? `${p.from_currency}→${p.to_currency}`,
          price:   p.price,
          bid:     p.bid,
          ask:     p.ask,
        }))
      : raw;
  } else {
    cryptoError = cryptoPricesRes.reason?.message ?? 'Error desconocido';
  }

  // ── Resumen de cobertura ───────────────────────────────────────────────────
  const coverageSummary = coverage
    ? Object.entries(coverage).reduce((acc, [table, entries]) => {
        const vitaSentOnly = entries.filter((e) => e.vitaSentOnly).map((e) => e.code);
        acc[table] = {
          count:        entries.length,
          countries:    entries.map((e) => e.code),
          vitaSentOnly: vitaSentOnly.length ? vitaSentOnly : undefined,
        };
        return acc;
      }, {})
    : null;

  return res.json({
    generatedAt: new Date().toISOString(),
    account:     'AV Finance SpA — Vita Wallet (cuenta única)',
    wallets:     { data: wallets,      error: walletsError },
    coverage:    { summary: coverageSummary, tables: coverage, error: pricesError },
    deposits:    { recent: deposits,   error: depositsError },
    cryptoPrices:{ data: cryptoPrices, error: cryptoError },
  });
}

// ─── vitaBalance ──────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/vita/balance
 * Retorna saldos actuales de la wallet master Vita + alertas de liquidez.
 */
export async function vitaBalance(req, res) {
  try {
    const walletsRes = await getWallets();
    const raw = walletsRes?.data ?? walletsRes;
    const walletsList = raw?.wallets ?? (Array.isArray(raw) ? raw : [raw]);
    const master = walletsList.find(w => w.attributes?.token === 'master') ?? walletsList[0];

    const balances = master?.attributes?.balances ?? {};

    const ALERT_THRESHOLDS = {
      clp:  500000,
      usd:  500,
      usdt: 500,
      usdc: 500,
      cop:  2000000,
    };

    const alerts = [];
    for (const [currency, threshold] of Object.entries(ALERT_THRESHOLDS)) {
      const current = balances[currency] ?? 0;
      if (current < threshold) {
        alerts.push({
          currency:  currency.toUpperCase(),
          current,
          threshold,
          level:     current < threshold * 0.5 ? 'critical' : 'warning',
          message:   `Saldo ${currency.toUpperCase()} bajo: ${current.toLocaleString()} (mínimo ${threshold.toLocaleString()})`,
        });
      }
    }

    return res.json({
      walletId:  master?.uuid,
      isMaster:  master?.attributes?.token === 'master',
      balances,
      alerts,
      hasAlerts: alerts.length > 0,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[vitaBalance]', err.message);
    return res.status(500).json({ error: 'Error consultando saldo Vita.' });
  }
}

// ─── testPush ─────────────────────────────────────────────────────────────────

export async function testPush(req, res) {
  const { userId, title, body } = req.body
  const { sendPushNotification } = await import('../services/notifications.js')
  const result = await sendPushNotification(
    userId ?? req.user._id,
    { title: title ?? 'Test push', body: body ?? 'Funcionando ✅', data: { type: 'test' } }
  )
  return res.json({ result })
}

// ─── Memory stats ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/health/memory
 * Observabilidad de uso de memoria del proceso + tamaño de caches internos.
 * Protegido por protect + checkAdmin en el router.
 */
export async function getMemoryStats(req, res) {
  const { userCache } = await import('../middlewares/authMiddleware.js');
  const mem  = process.memoryUsage();
  const toMB = (bytes) => Math.round(bytes / 1024 / 1024 * 100) / 100;

  res.json({
    rss:       `${toMB(mem.rss)} MB`,
    heapUsed:  `${toMB(mem.heapUsed)} MB`,
    heapTotal: `${toMB(mem.heapTotal)} MB`,
    external:  `${toMB(mem.external)} MB`,
    caches: {
      userCache: typeof userCache?.size === 'number' ? userCache.size : 'unknown',
    },
    uptime:      `${Math.round(process.uptime() / 60)} minutes`,
    nodeVersion: process.version,
  });
}

// ─── resetUserTokenVersion ───────────────────────────────────────────────────

/**
 * PATCH /api/v1/admin/users/:userId/reset-token-version
 * Resetea el contador tokenVersion del usuario a 0. Útil cuando el JWT en
 * el cliente quedó desincronizado respecto al DB (p. ej. tras logouts
 * repetidos en staging). Invalida el cache para que el próximo request
 * relea el documento desde MongoDB.
 */
export async function resetUserTokenVersion(req, res) {
  const { userId } = req.params;
  const { invalidateUserCache } = await import('../middlewares/authMiddleware.js');

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: { tokenVersion: 0 } },
    { new: true },
  ).select('_id email tokenVersion').lean();

  if (!user) {
    return res.status(404).json({ success: false, error: 'Usuario no encontrado.' });
  }

  invalidateUserCache(String(userId));

  return res.json({
    success: true,
    message: 'tokenVersion reset to 0',
    user: { id: user._id, email: user.email, tokenVersion: user.tokenVersion },
  });
}
