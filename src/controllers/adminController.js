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

import mongoose          from 'mongoose';
import User              from '../models/User.js';
import Transaction       from '../models/Transaction.js';
import TransactionConfig from '../models/TransactionConfig.js';
import WalletTransaction from '../models/WalletTransaction.js';
import { dispatchPayout } from './ipnController.js';
import { confirmBankQrDeposit } from './walletController.js';
import { notify, NOTIFICATIONS } from '../services/notifications.js';
import { sendEmail, EMAILS }    from '../services/email.js';
import {
  getPrices,
  getWallets,
  getDeposits,
  getCryptoPrices,
  VITA_SENT_ONLY_COUNTRIES,
  getVitaSentCountry,
}                         from '../services/vitaWalletService.js';
import { getBOBRate, convertOriginToUSD } from '../services/exchangeRateService.js';
import { calculateFintocFee } from '../utils/fintocFees.js';
import { denyIfProduction }   from '../middlewares/sandboxOnly.js';
import { recordAdminAction }  from '../services/adminAuditService.js';

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
      .select('firstName lastName email legalEntity kycStatus kybStatus accountType role isActive sanctionsFlag residenceCountry createdAt lastLoginAt')
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

// ─── getUser ──────────────────────────────────────────────────────────────────

export async function getUser(req, res) {
  try {
    const user = await User.findById(req.params.userId)
      .select('firstName lastName email legalEntity kycStatus kybStatus accountType role isActive sanctionsFlag residenceCountry createdAt lastLoginAt')
      .lean();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
    return res.json({ user });
  } catch (err) {
    console.error('[Admin] getUser error:', err.message);
    return res.status(500).json({ error: 'Error interno.' });
  }
}

// ─── updateUser ───────────────────────────────────────────────────────────────

const USER_ALLOWED_FIELDS = new Set([
  'accountType', 'legalEntity', 'kycStatus', 'role', 'isActive', 'sanctionsFlag',
]);

/**
 * Campos que NO son datos operativos sino decisiones de control interno:
 *   'role'          → escala privilegios (acceso al backoffice completo)
 *   'kycStatus'     → da por verificada una identidad sin pasar por Stripe Identity
 *   'sanctionsFlag' → levanta un bloqueo AML puesto por el screening OFAC/ONU/UIF
 *
 * Cambiarlos exige: no ser uno mismo, motivo persistido y AdminAuditLog.
 * (Cerrado 2026-08-15: antes eran editables como cualquier otro campo y no
 * dejaban ningún rastro — un admin podía auto-promoverse, aprobar KYC o
 * levantar un flag AML y no quedaba registro de quién ni por qué.)
 */
const USER_SENSITIVE_FIELDS = new Set(['role', 'kycStatus', 'sanctionsFlag']);

/** Longitud mínima del motivo exigido para un cambio sensible. */
const MIN_REASON_LENGTH = 10;

/**
 * Estados a los que NO se llega por el flujo normal sin una confirmación
 * externa (IPN del proveedor, job de conciliación o comprobante). Forzarlos a
 * mano equivale a afirmar que el dinero se movió: exige motivo y AdminAuditLog,
 * igual que /admin/vita/force-complete.
 */
const FORCED_TERMINAL_STATUSES = new Set(['completed', 'refunded']);

/**
 * `role` sale de la API por defecto: escalar privilegios no debe ser una edición
 * más del panel. `ADMIN_ROLE_MUTATION_ENABLED=true` es un break-glass explícito
 * y temporal — se enciende, se hace el cambio con su motivo, y se apaga.
 *
 * ⚠️ `npm run seed:admin` no promueve a nadie: crea un usuario nuevo con valores
 * de siembra. Desde el 23/08 rehúsa operar sobre una cuenta existente, y sobre una
 * con rol de administración rehúsa sin excepción posible — antes hacía `deleteOne`
 * incondicional y sin asiento. Ésta es la única vía para elevar a alguien.
 *
 * Se lee dentro de la función (regla 21 de CLAUDE.md).
 */
export function isRoleMutationEnabled() {
  return process.env.ADMIN_ROLE_MUTATION_ENABLED === 'true';
}

/** Normaliza booleanos que llegan como string desde el panel ('false' → false). */
function normalizeUserField(field, value) {
  if (field === 'isActive' || field === 'sanctionsFlag') {
    if (value === true  || value === 'true')  return true;
    if (value === false || value === 'false') return false;
  }
  return value;
}

/** Valor actual efectivo de un campo (con el default del schema). */
function currentUserField(user, field) {
  const defaults = { role: 'user', isActive: true, sanctionsFlag: false, kycStatus: 'pending' };
  return user[field] ?? defaults[field] ?? null;
}

export async function updateUser(req, res) {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

  // ⚠️ CANONICALIZAR el id ANTES de cualquier comparación de identidad.
  // ObjectId acepta hex en mayúsculas y castea al MISMO documento, pero
  // `String(req.user._id)` siempre sale en minúsculas: comparar los strings
  // crudos dejaba pasar `PATCH /admin/users/6A80E6…` como si fuera otro usuario
  // (auto-promoción y auto-levantamiento de flag AML). Además el targetId del
  // audit quedaba en mayúsculas y no aparecía al filtrar por el _id normal.
  if (!mongoose.isValidObjectId(req.params.userId)) {
    return res.status(400).json({ error: 'userId inválido.' });
  }
  const userId = new mongoose.Types.ObjectId(req.params.userId);

  const requested = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (USER_ALLOWED_FIELDS.has(k)) requested[k] = normalizeUserField(k, v);
  }
  if (Object.keys(requested).length === 0) {
    return res.status(400).json({ error: 'No hay campos válidos para actualizar.' });
  }

  try {
    // ── 1. Pre-imagen: hace falta para el audit y para descartar no-ops ──────
    // El panel manda el formulario completo en cada guardado, así que un campo
    // sensible presente pero SIN cambio no debe exigir motivo ni auditarse.
    const before = await User.findById(userId)
      .select('firstName lastName email legalEntity kycStatus kybStatus accountType role isActive sanctionsFlag')
      .lean();
    if (!before) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const updates = {};
    for (const [field, value] of Object.entries(requested)) {
      if (currentUserField(before, field) !== value) updates[field] = value;
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ user: before, unchanged: true });
    }

    const sensitiveChanged = Object.keys(updates).filter(f => USER_SENSITIVE_FIELDS.has(f));

    // ── 2. Validar enums ANTES de auditar ───────────────────────────────────
    // El audit se escribe antes de mutar (paso 6); sin esto, un valor que el
    // schema va a rechazar dejaría un registro de un cambio que nunca ocurrió.
    for (const field of ['role', 'kycStatus', 'legalEntity', 'accountType']) {
      if (updates[field] === undefined) continue;
      const allowed = User.schema.path(field)?.enumValues ?? [];
      if (allowed.length > 0 && !allowed.includes(updates[field])) {
        return res.status(400).json({
          error: `Valor inválido para ${field}. Permitidos: ${allowed.join(', ')}.`,
          field,
        });
      }
    }

    // ── 3. `role`: fuera de la API salvo break-glass explícito ───────────────
    if (updates.role !== undefined && !isRoleMutationEnabled()) {
      console.warn('[Admin] REJECT: intento de cambiar role vía API.', {
        userId, from: currentUserField(before, 'role'), to: updates.role,
        adminId: String(req.user._id), adminEmail: req.user.email,
      });
      // El mensaje NO debe remitir a `npm run seed:admin`. Ese script borra y
      // recrea el usuario: aplicado a una persona real le cambia el
      // identificador, la contraseña y los datos personales, y no escribe ningún
      // asiento. Es decir, ante el bloqueo de este control el sistema estaba
      // sugiriendo el único camino que destruye el rastro que el control existe
      // para producir — y un operador apurado lo sigue sin advertirlo.
      return res.status(403).json({
        error: 'El cambio de rol está fuera de la API por seguridad. Requiere habilitación temporal '
             + 'de la mutación de rol (ADMIN_ROLE_MUTATION_ENABLED) por quien administre el servidor, '
             + 'y se ejecuta desde este panel consignando el motivo, que queda en la bitácora.',
        code:  'ROLE_MUTATION_DISABLED',
      });
    }

    // ── 4. Ningún admin se modifica a sí mismo un campo sensible ────────────
    // Cierra la auto-promoción y el auto-levantamiento de bloqueos AML.
    if (sensitiveChanged.length > 0 && userId.equals(req.user._id)) {
      console.warn('[Admin] REJECT: auto-modificación de campos sensibles.', {
        userId, fields: sensitiveChanged, adminEmail: req.user.email,
      });
      return res.status(403).json({
        error:  'Un administrador no puede modificar su propio rol, estado KYC ni flag de sanciones. Debe hacerlo otro administrador.',
        code:   'SELF_MUTATION_FORBIDDEN',
        fields: sensitiveChanged,
      });
    }

    // ── 5. Motivo obligatorio y persistido ──────────────────────────────────
    if (sensitiveChanged.length > 0 && reason.length < MIN_REASON_LENGTH) {
      return res.status(400).json({
        error:  `Los cambios de ${sensitiveChanged.join(', ')} exigen un motivo de al menos ${MIN_REASON_LENGTH} caracteres (queda registrado en la auditoría).`,
        code:   'REASON_REQUIRED',
        fields: sensitiveChanged,
      });
    }

    // ── 6. Auditoría ANTES de mutar ─────────────────────────────────────────
    // Sin sesión Mongo no hay atomicidad entre el cambio y su registro, así que
    // se invierte el orden: si el audit no se puede escribir, el cambio no se
    // aplica. Un registro sin cambio es detectable; un cambio de privilegios sin
    // registro es exactamente el defecto que se está cerrando.
    let auditLogId = null;
    if (sensitiveChanged.length > 0) {
      const log = await recordAdminAction({
        req,
        action:     'user.sensitive_update',
        targetType: 'User',
        targetId:   userId,
        before:     Object.fromEntries(sensitiveChanged.map(f => [f, currentUserField(before, f)])),
        after:      Object.fromEntries(sensitiveChanged.map(f => [f, updates[f]])),
        reason,
        metadata:   {
          targetEmail:   before.email,
          allFields:     Object.keys(updates),
          roleBreakGlass: updates.role !== undefined ? true : undefined,
        },
      });
      if (!log) {
        return res.status(500).json({
          error: 'No se pudo registrar la acción en la auditoría. El cambio no se aplicó.',
          code:  'AUDIT_WRITE_FAILED',
        });
      }
      auditLogId = String(log._id);
    }

    // ── 7. Aplicar el cambio ────────────────────────────────────────────────
    const setOp = { ...updates, updatedAt: new Date() };
    const incOp = {};
    if (updates.isActive === false) {
      incOp.tokenVersion = 1;
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: setOp, ...(Object.keys(incOp).length ? { $inc: incOp } : {}) },
      { returnDocument: 'after', runValidators: true },
    ).select('firstName lastName email legalEntity kycStatus kybStatus accountType role isActive sanctionsFlag updatedAt').lean();

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    // Un cambio de rol o de estado debe reflejarse ya en el próximo request:
    // protect() cachea el usuario 10 s.
    const { invalidateUserCache } = await import('../middlewares/authMiddleware.js');
    invalidateUserCache(String(userId));

    console.info('[Admin] Usuario actualizado:', {
      userId, fields: Object.keys(updates), sensitiveChanged,
      adminId: String(req.user._id), auditLogId,
    });
    return res.json({ user, ...(auditLogId ? { auditLogId } : {}) });
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
    console.error('[Admin] updateUser error:', err.message);
    return res.status(500).json({ error: 'Error interno.' });
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
      .sort({ isPrioritySupport: -1, createdAt: -1 })
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

// Status válidos según el enum del modelo Transaction (15 valores, alineado con Transaction.js)
const VALID_STATUSES = [
  'pending', 'initiated', 'payin_pending', 'payin_confirmed', 'payin_completed',
  'processing', 'in_transit', 'payout_pending', 'payout_sent',
  'payout_pending_usdc_send', 'payout_in_transit', 'pending_funding',
  'completed', 'failed', 'refunded',
];

// ─── TAB_FILTERS ──────────────────────────────────────────────────────────────
// Filtros por tab del Ledger admin. El tab controla qué sección del flujo mira
// el admin. `unpaid` es una vista debug que lista payin sin comprobante.
export const TAB_FILTERS = {
  actionable: {
    status:       'payin_pending',
    paymentProof: { $exists: true, $ne: null },
  },
  manual_payout: {
    status: { $in: [
      'pending_funding',
      'payout_pending',
      'payout_pending_usdc_send',
    ] },
  },
  in_progress: {
    status: { $in: [
      'payin_confirmed', 'payin_completed', 'processing',
      'in_transit', 'payout_sent', 'payout_in_transit',
    ] },
  },
  history: {
    status: { $in: ['completed', 'failed', 'refunded'] },
  },
  unpaid: {
    $and: [
      { status: { $in: ['pending', 'initiated', 'payin_pending'] } },
      { $or: [
        { paymentProof: { $exists: false } },
        { paymentProof: null },
      ] },
    ],
  },
};

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
    status: rawStatus, entity, startDate, endDate,
    corridorId: corridorSlug,
  } = req.query;

  // 'all' es un sinónimo de "sin filtro de status" para el frontend.
  const status  = rawStatus === 'all' ? undefined : rawStatus;
  const showAll = req.query.showAll === 'true';

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

  // Base para el conteo "pendientes sin comprobante" — respeta entity/fechas/corredor
  // pero ignora el status y el filtro por defecto "accionables".
  const pendingBaseFilter = { ...filter };

  // ── 2b. Filtro por tab ────────────────────────────────────────────────────
  // `tab` controla qué sección del flujo ve el admin. Si el admin pasa un
  // `status` explícito o `tab=all` / `showAll=true`, el filtro por tab se
  // salta (el status explícito gana para backcompat con filtros manuales).
  const rawTab = req.query.tab;
  const bypassTab = rawTab === 'all' || showAll || !!status;
  if (!bypassTab) {
    const tab       = rawTab || 'actionable';
    const tabFilter = TAB_FILTERS[tab] || TAB_FILTERS.actionable;
    Object.assign(filter, tabFilter);
  }

  // ── 3. Ejecutar en paralelo: agregación de resumen + consulta paginada ────
  try {
    const [summaryResult, transactions, pendingNoProofCount] = await Promise.all([
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
      ]).option({ maxTimeMS: 10000 }),

      // Consulta paginada con populate del usuario
      // Excluimos paymentProof.data (base64 hasta 5MB/doc) para no inflar el payload;
      // mantenemos la metadata (mimetype/filename/uploadedAt) para que el frontend
      // pueda detectar si existe comprobante sin descargar su contenido.
      Transaction.find(filter)
        .populate('userId', 'email firstName lastName')
        .sort({ isPrioritySupport: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('-paymentProof.data')
        .maxTimeMS(10000)
        .lean(),

      // Conteo para el banner: payin_pending sin comprobante dentro del scope base
      Transaction.countDocuments({
        ...pendingBaseFilter,
        status: 'payin_pending',
        paymentProof: { $exists: false },
      }).maxTimeMS(10000),
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
        totalVolume:         agg.totalVolume    ?? 0,
        totalCompleted:      agg.totalCompleted ?? 0,
        totalFailed:         agg.totalFailed    ?? 0,
        totalFees:           agg.totalFees      ?? 0,
        pendingNoProofCount: pendingNoProofCount ?? 0,
      },
    });

  } catch (err) {
    console.error('[Admin listTransactions] Error:', err.message);
    console.error('[Admin listTransactions] Stack:', err.stack);
    return res.status(500).json({
      error: 'Error al obtener transacciones.',
      detail: process.env.NODE_ENV !== 'production'
        ? err.message
        : undefined,
    });
  }
}

// ─── getLedgerCounts ──────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/ledger/counts
 *
 * Devuelve los conteos por tab del Ledger admin. Usado por el frontend para
 * mostrar badges en las pestañas y refrescar cada ~15 s.
 */
export async function getLedgerCounts(req, res) {
  try {
    const [actionable, manualPayout, inProgress, history, unpaid] = await Promise.all([
      Transaction.countDocuments(TAB_FILTERS.actionable).maxTimeMS(5000),
      Transaction.countDocuments(TAB_FILTERS.manual_payout).maxTimeMS(5000),
      Transaction.countDocuments(TAB_FILTERS.in_progress).maxTimeMS(5000),
      Transaction.countDocuments(TAB_FILTERS.history).maxTimeMS(5000),
      Transaction.countDocuments(TAB_FILTERS.unpaid).maxTimeMS(5000),
    ]);

    return res.json({
      actionable,
      manual_payout: manualPayout,
      in_progress:   inProgress,
      history,
      unpaid,
      total:         actionable + manualPayout + inProgress + history + unpaid,
      timestamp:     new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Admin getLedgerCounts] Error:', err.message);
    return res.status(500).json({ error: 'Error al obtener conteos.' });
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

  // ── Estados terminales: motivo reforzado + auditoría ──────────────────────
  // Forzar a mano 'completed' o 'refunded' es afirmar que el dinero llegó (o
  // volvió) sin verificación externa: habilita emitir el Comprobante Oficial
  // vía /admin/regenerate-comprobante y cierra la operación de cara al usuario.
  // /admin/vita/force-complete exige motivo y AdminAuditLog; sin esto, este
  // endpoint era el mismo poder con una `note` de un carácter y sin rastro
  // fuera del ipnLog de la propia transacción (cerrado 2026-08-15).
  const esForzadoTerminal = FORCED_TERMINAL_STATUSES.has(newStatus)
    && previousStatus !== newStatus;

  if (esForzadoTerminal && note.trim().length < MIN_REASON_LENGTH) {
    return res.status(400).json({
      error: `Llevar una transacción a '${newStatus}' a mano exige un motivo de al menos ${MIN_REASON_LENGTH} caracteres (queda registrado en la auditoría).`,
      code:  'REASON_REQUIRED',
      previousStatus,
    });
  }

  // ── Guard anti-doble-payout: confirmar payin SOLO desde estados pre-payout ──
  // Sin esto, un admin podría regrabar a 'payin_confirmed' una tx ya liquidada
  // (payout_sent/completed) y disparar un SEGUNDO envío de USDC real.
  if (newStatus === 'payin_confirmed') {
    const ALLOWED_FROM = ['payin_pending', 'pending_funding', 'payin_confirmed'];
    if (!ALLOWED_FROM.includes(previousStatus)) {
      console.warn('[Admin updateTransactionStatus] REJECT confirmación inválida:', {
        transactionId, previousStatus, newStatus,
      });
      return res.status(409).json({
        error: `No se puede confirmar payin de una transacción en estado '${previousStatus}'. ` +
               `Ya pasó la etapa de payout — confirmar de nuevo causaría un doble envío.`,
        previousStatus,
      });
    }
  }

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

  // Auditoría ANTES de mutar: si no se puede dejar rastro, no se fuerza el estado.
  if (esForzadoTerminal) {
    const auditLog = await recordAdminAction({
      req,
      action:     'transaction.force_status',
      targetType: 'Transaction',
      targetId:   String(transaction._id),
      before:     { status: previousStatus },
      after:      { status: newStatus },
      reason:     note.trim(),
      metadata:   {
        alytoTransactionId:  transaction.alytoTransactionId,
        bankReference:       bankReference?.trim() ?? null,
        destinationAmount:   transaction.destinationAmount,
        destinationCurrency: transaction.destinationCurrency,
      },
    });
    if (!auditLog) {
      return res.status(500).json({
        error: 'No se pudo registrar la acción en la auditoría. El estado no se modificó.',
        code:  'AUDIT_WRITE_FAILED',
      });
    }
  }

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
    // Disparar dispatch si el payin fue confirmado manualmente (desde payin_pending)
    // o si el admin re-confirma para reintentar tras insufficient USDC (desde pending_funding).
    const DISPATCH_FROM = ['payin_pending', 'pending_funding', 'payout_pending_usdc_send'];
    if (!DISPATCH_FROM.includes(previousStatus)) {
      console.warn('[Admin] dispatchPayout bloqueado — status ya avanzado:', {
        transactionId: transaction.alytoTransactionId,
        previousStatus,
      });
    } else {
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
  }

  return res.json({ transaction });
}

// ─── CORREDORES ───────────────────────────────────────────────────────────────

// Campos protegidos que no pueden modificarse vía este endpoint.
// ⚠️ 'changeLog' es el historial de cambios de comisiones del corredor — es la
// evidencia de quién tocó qué fee y cuándo. Sin protegerlo, el bucle de
// updateCorridor asigna cualquier campo no listado aquí, así que un
// PATCH {"changeLog": []} borraba el historial completo (cerrado 2026-08-15).
const CORRIDOR_PROTECTED_FIELDS = new Set([
  'corridorId', '_id', '__v', 'createdAt', 'updatedAt', 'changeLog',
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

  if (!['manual', 'bankQr'].includes(corridor.payinMethod)) {
    return res.status(400).json({
      error:        `setCorridorRate solo aplica a corredores manual o bankQr. Este corredor usa '${corridor.payinMethod}'.`,
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

    const ALLOWED_FIELDS = [
      'originCountry', 'destinationCountry', 'originCurrency', 'destinationCurrency',
      'payinMethod', 'payoutMethod', 'stellarAsset',
      'alytoCSpread', 'businessAlytoCSpread', 'businessFixedFee', 'fixedFee',
      'payinFeePercent', 'fintocConfig', 'payoutFeeFixed', 'profitRetentionPercent',
      'vitaRateMarkup', 'manualExchangeRate', 'fallbackPayoutMethod',
      'minAmountOrigin', 'minAmountUSD', 'minAmountUSDBusiness', 'maxAmountOrigin',
      'legalEntity', 'routingScenario', 'isActive', 'adminNotes',
    ];
    const safeBody = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => ALLOWED_FIELDS.includes(k))
    );
    const corridor = await TransactionConfig.create({
      ...safeBody,
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

// ─── updateGlobalPricing ──────────────────────────────────────────────────────

/**
 * PATCH /api/v1/admin/pricing/global
 *
 * Actualiza pricing personal y/o business en múltiples corredores de una vez.
 *
 * Body:
 *   legalEntity   — 'SRL' | 'SpA' | 'LLC' | 'all'
 *   corridorGroup — 'all' | 'standard' | 'harbor'  (default: 'all')
 *   personal      — { spreadPercent, fixedFee }     (alytoCSpread + fixedFee)
 *   business      — { spreadPercent, fixedFee }     (businessAlytoCSpread + businessFixedFee)
 */
export async function updateGlobalPricing(req, res) {
  const { legalEntity, corridorGroup = 'all', personal, business } = req.body;

  if (!legalEntity) {
    return res.status(400).json({ error: 'legalEntity requerido (SRL | SpA | LLC | all).' });
  }
  if (!personal && !business) {
    return res.status(400).json({ error: 'Al menos personal o business requerido.' });
  }

  const filter = {};
  if (legalEntity !== 'all') filter.legalEntity = legalEntity;
  if (corridorGroup === 'standard') filter.payoutMethod = { $in: ['vitaWallet', 'anchorBolivia'] };
  else if (corridorGroup === 'harbor') filter.payoutMethod = 'owlPay';

  const $set = { updatedAt: new Date() };
  if (personal?.spreadPercent != null) $set.alytoCSpread           = personal.spreadPercent;
  if (personal?.fixedFee      != null) $set.fixedFee               = personal.fixedFee;
  if (business?.spreadPercent != null) $set.businessAlytoCSpread   = business.spreadPercent;
  if (business?.fixedFee      != null) $set.businessFixedFee       = business.fixedFee;

  let affected;
  try {
    affected = await TransactionConfig
      .find(filter)
      .select('_id corridorId alytoCSpread fixedFee businessAlytoCSpread businessFixedFee')
      .lean();
  } catch (err) {
    console.error('[Admin updateGlobalPricing] Error buscando corredores:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  if (affected.length === 0) {
    return res.status(404).json({ error: 'No se encontraron corredores con los filtros indicados.' });
  }

  try {
    await TransactionConfig.updateMany(filter, { $set });

    const now    = new Date();
    const adminId = req.user._id;
    await Promise.all(affected.map(c =>
      TransactionConfig.updateOne(
        { _id: c._id },
        { $push: { changeLog: {
            changedAt: now,
            changedBy: adminId,
            field:     'global_pricing_update',
            oldValue:  JSON.stringify({
              alytoCSpread:         c.alytoCSpread,
              fixedFee:             c.fixedFee,
              businessAlytoCSpread: c.businessAlytoCSpread,
              businessFixedFee:     c.businessFixedFee,
            }),
            newValue: JSON.stringify($set),
          }},
        },
      )
    ));
  } catch (err) {
    console.error('[Admin updateGlobalPricing] Error aplicando update:', err.message);
    return res.status(500).json({ error: 'Error al actualizar los corredores.' });
  }

  console.info('[Admin] Global pricing actualizado:', {
    legalEntity, corridorGroup,
    corridorsUpdated: affected.length,
    adminId: req.user._id.toString(),
    applied: $set,
  });

  return res.json({
    success:          true,
    corridorsUpdated: affected.length,
    legalEntity,
    corridorGroup,
    applied: {
      personal: personal ?? 'no change',
      business: business ?? 'no change',
    },
    preview: affected.map(c => ({
      corridorId:      c.corridorId,
      personalSpread:  $set.alytoCSpread         ?? c.alytoCSpread,
      personalFixed:   $set.fixedFee             ?? c.fixedFee,
      businessSpread:  $set.businessAlytoCSpread ?? c.businessAlytoCSpread,
      businessFixed:   $set.businessFixedFee     ?? c.businessFixedFee,
    })),
  });
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

    // Verificar que no haya transacciones en vuelo antes de desactivar
    const IN_FLIGHT_STATUSES = ['payin_pending', 'payin_confirmed', 'processing', 'payout_pending', 'payout_sent', 'payout_in_transit', 'pending_funding'];
    const inFlightCount = await Transaction.countDocuments({
      corridorId: corridor._id,
      status:     { $in: IN_FLIGHT_STATUSES },
    });
    if (inFlightCount > 0) {
      return res.status(409).json({
        error: `No se puede desactivar el corredor: hay ${inFlightCount} transacción(es) en proceso. Espera a que finalicen.`,
        inFlightCount,
      });
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

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/**
 * GET /api/v1/admin/analytics
 *
 * Analytics global: volumen total, revenue, desglose por entidad y corredor.
 * Las fees se guardan en moneda origen (BOB/CLP/USD); aquí se normalizan a USD
 * (tasas live) para un total coherente, y se expone el desglose por moneda.
 * Query params: startDate, endDate (ISO)
 */
export async function getGlobalAnalytics(req, res) {
  let { startDate, endDate, period } = req.query;

  // Convertir period (7d|30d|90d) a rango de fechas si no vienen startDate/endDate
  if (!startDate && !endDate && period) {
    const days = { '7d': 7, '30d': 30, '90d': 90 }[period] ?? 30;
    const from  = new Date();
    from.setDate(from.getDate() - days);
    startDate = from.toISOString();
  }

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

  // Expresiones reutilizables.
  // Ganancia = SOLO fees explícitas de Alyto (spread + fijo + retención).
  // payinFee/payoutFee son costos de proveedor (pass-through) → NO son ganancia.
  // El margen del buffer FX NO se cuenta como ganancia (decisión de producto).
  const revenueExpr = {
    $add: [
      { $ifNull: ['$fees.alytoCSpread',   0] },
      { $ifNull: ['$fees.fixedFee',        0] },
      { $ifNull: ['$fees.profitRetention', 0] },
    ],
  };
  // Moneda de los montos: feeCurrency de la tx, fallback a originCurrency, fallback USD.
  const currencyExpr = { $ifNull: ['$fees.feeCurrency', { $ifNull: ['$originCurrency', 'USD'] }] };

  try {
    const [byCurrencyResult, byEntityResult, byCorridorResult, countsResult] = await Promise.all([

      // ── Volumen + ganancia agrupados POR MONEDA (para normalizar a USD) ────
      Transaction.aggregate([
        { $match: dateFilter },
        { $group: { _id: currencyExpr, volume: { $sum: '$originalAmount' }, revenue: { $sum: revenueExpr }, transactions: { $sum: 1 } } },
      ]),

      // ── By entity (entidad + moneda; cada entidad suele ser una sola moneda) ─
      Transaction.aggregate([
        { $match: dateFilter },
        { $group: { _id: { entity: '$legalEntity', currency: currencyExpr }, transactions: { $sum: 1 }, volume: { $sum: '$originalAmount' }, revenue: { $sum: revenueExpr } } },
      ]),

      // ── By corridor (un corredor = una moneda) ────────────────────────────
      Transaction.aggregate([
        { $match: dateFilter },
        { $group: { _id: '$corridorId', currency: { $first: currencyExpr }, transactions: { $sum: 1 }, volume: { $sum: '$originalAmount' }, revenue: { $sum: revenueExpr } } },
        { $sort: { volume: -1 } },
      ]),

      // ── Conteos globales (independientes de moneda) ───────────────────────
      Transaction.aggregate([
        { $match: dateFilter },
        { $group: {
          _id: null,
          totalTransactions:     { $sum: 1 },
          completedTransactions: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          failedTransactions:    { $sum: { $cond: [{ $eq: ['$status', 'failed'] },    1, 0] } },
        } },
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

    // ── Normalización a USD por moneda (tasas live) ───────────────────────
    // Cachear la conversión por moneda para no repetir lookups.
    const usdCache = new Map();
    const toUsd = async (amount, currency) => {
      if (!amount) return 0;
      const cur = currency ?? 'USD';
      if (!usdCache.has(cur)) usdCache.set(cur, await convertOriginToUSD(1, cur));
      return amount * usdCache.get(cur);
    };

    // Desglose por moneda + totales USD.
    const byCurrency = [];
    let totalVolumeUsd = 0;
    let totalRevenueUsd = 0;
    for (const row of byCurrencyResult) {
      const currency  = row._id ?? 'USD';
      const volumeUsd  = await toUsd(row.volume,  currency);
      const revenueUsd = await toUsd(row.revenue, currency);
      totalVolumeUsd  += volumeUsd;
      totalRevenueUsd += revenueUsd;
      byCurrency.push({
        currency,
        volume:     round2(row.volume),
        revenue:    round2(row.revenue),
        volumeUsd:  round2(volumeUsd),
        revenueUsd: round2(revenueUsd),
        transactions: row.transactions,
      });
    }
    byCurrency.sort((a, b) => b.volumeUsd - a.volumeUsd);

    totalVolumeUsd  = round2(totalVolumeUsd);
    totalRevenueUsd = round2(totalRevenueUsd);
    const c = countsResult[0] ?? { totalTransactions: 0, completedTransactions: 0, failedTransactions: 0 };
    const avgRevenuePct = totalVolumeUsd > 0
      ? parseFloat(((totalRevenueUsd / totalVolumeUsd) * 100).toFixed(2))
      : 0;

    // ── Por entidad (suma en USD + moneda nativa) ─────────────────────────
    const byEntity = { SpA: null, LLC: null, SRL: null };
    for (const row of byEntityResult) {
      const entity   = row._id?.entity;
      const currency = row._id?.currency ?? 'USD';
      if (!entity) continue;
      const volumeUsd  = await toUsd(row.volume,  currency);
      const revenueUsd = await toUsd(row.revenue, currency);
      if (!byEntity[entity]) byEntity[entity] = { transactions: 0, volume: 0, revenue: 0, volumeUsd: 0, revenueUsd: 0, currency };
      byEntity[entity].transactions += row.transactions;
      byEntity[entity].volume       += round2(row.volume);
      byEntity[entity].revenue      += round2(row.revenue);
      byEntity[entity].volumeUsd    += volumeUsd;
      byEntity[entity].revenueUsd   += revenueUsd;
    }
    for (const entity of ['SpA', 'LLC', 'SRL']) {
      if (!byEntity[entity]) byEntity[entity] = { transactions: 0, volume: 0, revenue: 0, volumeUsd: 0, revenueUsd: 0, currency: null };
      else { byEntity[entity].volumeUsd = round2(byEntity[entity].volumeUsd); byEntity[entity].revenueUsd = round2(byEntity[entity].revenueUsd); }
    }

    // ── Por corredor (moneda nativa + USD) ────────────────────────────────
    const byCorridor = [];
    for (const row of byCorridorResult) {
      const currency   = row.currency ?? 'USD';
      const revenueUsd = await toUsd(row.revenue, currency);
      const volumeUsd  = await toUsd(row.volume,  currency);
      byCorridor.push({
        corridorId:     corridorSlugMap[row._id?.toString()] ?? row._id?.toString() ?? 'unknown',
        currency,
        transactions:   row.transactions,
        volume:         round2(row.volume),
        revenue:        round2(row.revenue),
        volumeUsd:      round2(volumeUsd),
        revenueUsd:     round2(revenueUsd),
        revenuePercent: row.volume > 0 ? parseFloat(((row.revenue / row.volume) * 100).toFixed(2)) : 0,
      });
    }

    return res.json({
      period: { startDate: startDate ?? null, endDate: endDate ?? null },
      currency: 'USD',   // moneda de los totales normalizados
      global: {
        totalTransactions:     c.totalTransactions,
        completedTransactions: c.completedTransactions,
        failedTransactions:    c.failedTransactions,
        totalVolumeUsd,
        totalRevenueUsd,
        avgRevenuePercent:     avgRevenuePct,
        // Alias retro-compat (ahora en USD, ya NO mezcla monedas):
        totalVolumeCLP:        totalVolumeUsd,
        totalRevenueCLP:       totalRevenueUsd,
      },
      byCurrency,
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
    // Un solo total: el que se descuenta y el que se informa son el mismo.
    const totalDeducted     = round2(payinFee + alytoCSpread + fixedFee + profitRetention);
    const totalDeductedReal = totalDeducted;
    const netAmount         = round2(amount - totalDeductedReal);

    // ── Calcular tasa y monto destino ─────────────────────────────────────
    let effectiveRate      = null;
    let destinationAmount  = null;
    let rateSource         = null;
    let rateBreakdown      = null;

    if (vitaAttrs) {
      // Países vita_sent usan su clave propia (EU → 'es'); el resto, ISO minúsculas.
      const destKey = VITA_SENT_ONLY_COUNTRIES.has(destUpper)
        ? getVitaSentCountry(destUpper).toLowerCase()
        : c.destinationCountry.toLowerCase();

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
        minAmountUSD:       c.minAmountUSD,
        minAmountUSDBusiness: c.minAmountUSDBusiness,
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

// ─── stellarBalance ───────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/stellar/balance
 * Retorna el saldo USDC real de la wallet Stellar SRL consultando Horizon.
 * Incluye la dirección pública y el link a Stellar Expert para el admin.
 */
export async function stellarBalance(req, res) {
  try {
    const { getStellarUSDCBalance } = await import('../services/stellarService.js');

    const entity    = req.query.entity ?? 'SRL';
    const pubKeyEnv = entity === 'LLC' ? 'STELLAR_LLC_PUBLIC_KEY' : 'STELLAR_SRL_PUBLIC_KEY';
    const publicKey = process.env[pubKeyEnv];

    if (!publicKey) {
      return res.status(500).json({ error: `Variable de entorno ${pubKeyEnv} no configurada.` });
    }

    const usdcBalance = await getStellarUSDCBalance(publicKey);

    const network   = (process.env.STELLAR_NETWORK ?? 'testnet').toLowerCase();
    const explorerNet = network === 'mainnet' || network === 'public' ? 'public' : 'testnet';
    const stellarExpertUrl = `https://stellar.expert/explorer/${explorerNet}/account/${publicKey}`;

    return res.json({
      entity,
      publicKey,
      network:         explorerNet,
      balance: {
        usdc: usdcBalance,
      },
      stellarExpertUrl,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[stellarBalance]', err.message);
    return res.status(500).json({ error: 'Error consultando saldo Stellar.' });
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
// ─── simulateBankQrPayment ────────────────────────────────────────────────────
/**
 * POST /api/v1/admin/transactions/:transactionId/simulate-bankqr-payment
 *
 * Simula el webhook IPN del banco para una transacción bankQr en payin_pending.
 * SOLO PARA SANDBOX — confirma el pago sin intervención del banco real.
 * Equivale a lo que haría el IPN de BEC cuando el usuario paga el QR.
 *
 * ⚠️ El "SOLO PARA SANDBOX" era hasta 2026-08-15 únicamente documental: sin
 * guard de entorno, en producción esto acredita saldo BOB de la nada
 * (confirmBankQrDeposit → $inc balance) o marca payin_confirmed y dispara
 * dispatchPayout — un payout internacional real contra un ingreso inexistente.
 * La ruta aplica `sandboxOnly`; aquí se revalida (defensa en profundidad)
 * porque este handler crea saldo sobre fondos de terceros bajo custodia.
 */
export async function simulateBankQrPayment(req, res) {
  if (denyIfProduction(res, 'simulate-bankqr-payment')) return;

  const { transactionId } = req.params;

  const transaction = await Transaction.findOne({ alytoTransactionId: transactionId });

  if (!transaction) {
    // ¿Es una carga de Wallet BOB vía bankQr? (el id es el wtxId)
    const wtx = await WalletTransaction.findOne({ wtxId: transactionId });
    if (wtx) {
      if (wtx.status !== 'pending') {
        return res.status(409).json({ error: `Estado inválido para simular: ${wtx.status}. Solo aplica a pending.` });
      }
      if (!wtx.bankQr?.qrId) {
        return res.status(400).json({ error: 'El depósito no tiene un QR bancario asociado.' });
      }
      const nowSim = new Date();
      const simPayment = {
        simulated:   true,
        simulatedAt: nowSim.toISOString(),
        simulatedBy: req.user?.email ?? 'admin',
        qrId:        wtx.bankQr.qrId,
        amount:      wtx.amount,
        currency:    'BOB',
      };
      try {
        const r = await confirmBankQrDeposit(wtx, simPayment, wtx.bankQr.bankId ?? 'bec', 'admin_simulate');
        return res.json({
          success: true,
          wtxId:   wtx.wtxId,
          message: r.ok ? 'Depósito wallet simulado y acreditado.' : `No procesado: ${r.reason}`,
        });
      } catch (err) {
        return res.status(500).json({ error: 'Error acreditando depósito simulado.' });
      }
    }
    return res.status(404).json({ error: 'Transacción no encontrada.' });
  }
  if (transaction.status !== 'payin_pending') {
    return res.status(409).json({
      error: `Estado inválido para simular: ${transaction.status}. Solo aplica a payin_pending.`,
    });
  }
  if (!transaction.bankQr?.qrId) {
    return res.status(400).json({ error: 'La transacción no tiene un QR bancario asociado.' });
  }

  const now = new Date();

  transaction.status        = 'payin_confirmed';
  transaction.bankQr.paidAt = now;
  transaction.bankQr.payment = {
    simulated:   true,
    simulatedAt: now.toISOString(),
    simulatedBy: req.user?.email ?? 'admin',
    qrId:        transaction.bankQr.qrId,
    amount:      transaction.originalAmount,
    currency:    transaction.originCurrency,
  };
  transaction.payinReference = transaction.bankQr.qrId;
  transaction.confirmationDetails = {
    confirmedBy:      req.user._id,
    confirmedAt:      now,
    confirmationNote: 'Pago simulado en sandbox por admin',
    bankReference:    `SIM-${transaction.bankQr.qrId}`,
  };
  transaction.ipnLog.push({
    provider:   'bankQr',
    eventType:  'bankqr_payin_confirmed',
    status:     'payin_confirmed',
    rawPayload: { simulated: true, simulatedBy: req.user?.email, qrId: transaction.bankQr.qrId },
    receivedAt: now,
  });

  try {
    await transaction.save();
  } catch (err) {
    return res.status(500).json({ error: 'Error guardando transacción simulada.' });
  }

  // Notificar usuario
  notify(transaction.userId, NOTIFICATIONS.payinConfirmed(
    transaction.originalAmount, transaction.originCurrency,
  )).catch(() => {});

  // Dispatch payout fire-and-forget
  dispatchPayout(transaction).catch(() => {});

  return res.json({
    success: true,
    transactionId,
    message: 'Pago bancario simulado. Payout iniciado.',
  });
}

export async function resetUserTokenVersion(req, res) {
  const { userId } = req.params;
  const { invalidateUserCache } = await import('../middlewares/authMiddleware.js');

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: { tokenVersion: 0 } },
    { returnDocument: 'after' },
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

// ─── SEP-24 — Cierre de instrucciones caducadas ──────────────────────────────
//
// Una instrucción SEP-24 queda en `sep24_*_pending` esperando que el usuario
// envíe los fondos. Si nunca los envía, la instrucción caduca pero el documento
// se queda en ese estado para siempre: `updateTransactionStatus` no acepta
// 'cancelled' (ver VALID_STATUSES), así que el backoffice no tenía forma de
// cerrarlas y el único camino era escribir directo en la base.
//
// Estos dos endpoints cierran ese hueco con un control auditable: se listan los
// candidatos con sus bloqueos evaluados, y el cierre exige que el operador nombre
// explícitamente las instrucciones y justifique la acción. Nunca hay barrido
// masivo implícito.

/** Estados SEP-24 en los que una instrucción espera fondos del usuario. */
const SEP24_PENDING_STATUSES = ['sep24_deposit_pending', 'sep24_withdraw_pending'];

/**
 * Determina si una instrucción SEP-24 puede cerrarse administrativamente.
 *
 * Solo es seguro cerrar cuando caducó y no existe ni un indicio de que hayan
 * llegado fondos. Cerrar una instrucción con fondos recibidos dejaría al usuario
 * sin acreditar y sin registro del reclamo, que es exactamente el daño que hay
 * que evitar — de ahí que los tres controles de rastro sean excluyentes.
 *
 * @param {object} tx  documento Transaction (lean o hidratado)
 * @param {Date}   now
 * @returns {{ safeToCancel: boolean, blockers: string[] }}
 */
export function evaluateSep24Closure(tx, now = new Date()) {
  const blockers = [];

  if (!SEP24_PENDING_STATUSES.includes(tx.status)) {
    blockers.push(`status '${tx.status}': no es una instrucción SEP-24 pendiente`);
  }

  if (!tx.expiresAt) {
    blockers.push('sin fecha de expiración: no se puede afirmar que haya caducado');
  } else if (new Date(tx.expiresAt) >= now) {
    // Comparación inclusiva a propósito: en el instante exacto del vencimiento la
    // instrucción todavía se considera vigente. El daño es asimétrico — dejarla
    // abierta un momento más solo ensucia el backoffice; cerrarla un momento antes
    // puede descartar un depósito en curso.
    blockers.push(`vigente hasta ${new Date(tx.expiresAt).toISOString()}`);
  }

  if (tx.stellarTxHash || tx.stellarTxId) {
    blockers.push('tiene transacción Stellar asociada: pudo haber recibido fondos');
  }
  if (tx.externalTransactionId) {
    blockers.push('tiene referencia externa del proveedor');
  }
  if ((tx.ipnLog?.length ?? 0) > 0) {
    blockers.push(`registra ${tx.ipnLog.length} evento(s) en ipnLog`);
  }

  return { safeToCancel: blockers.length === 0, blockers };
}

/** Filtro que resuelve un identificador que puede ser alytoTransactionId o _id. */
function sep24IdFilter(rawId) {
  const id = String(rawId).trim();
  const or = [{ alytoTransactionId: id }];
  if (mongoose.Types.ObjectId.isValid(id)) or.push({ _id: id });
  return { $or: or };
}

/**
 * GET /api/v1/admin/transactions/sep24/expired
 *
 * Lista las instrucciones SEP-24 pendientes con su evaluación de cierre. No muta
 * nada: es la vista que el operador revisa antes de decidir.
 *
 * Query: ?includeActive=true para ver también las que siguen vigentes.
 */
export async function listExpiredSep24(req, res) {
  const includeActive = String(req.query.includeActive ?? '') === 'true';
  const now = new Date();

  let docs;
  try {
    docs = await Transaction.find({ status: { $in: SEP24_PENDING_STATUSES } })
      .select('alytoTransactionId status sep24Type originalAmount originCurrency createdAt expiresAt stellarTxHash stellarTxId externalTransactionId ipnLog')
      .sort({ createdAt: 1 })
      .lean();
  } catch (err) {
    console.error('[Admin listExpiredSep24] Error:', err.message);
    return res.status(500).json({ error: 'Error al listar instrucciones SEP-24.' });
  }

  const items = docs.map((tx) => {
    const { safeToCancel, blockers } = evaluateSep24Closure(tx, now);
    return {
      alytoTransactionId: tx.alytoTransactionId,
      id:                 String(tx._id),
      status:             tx.status,
      sep24Type:          tx.sep24Type ?? null,
      amount:             tx.originalAmount ?? null,
      currency:           tx.originCurrency ?? null,
      createdAt:          tx.createdAt,
      expiresAt:          tx.expiresAt ?? null,
      safeToCancel,
      blockers,
    };
  }).filter((it) => includeActive || it.safeToCancel || it.blockers.every((b) => !b.startsWith('vigente hasta')));

  return res.json({
    success:   true,
    total:     items.length,
    cancelable: items.filter((it) => it.safeToCancel).length,
    items,
  });
}

/**
 * POST /api/v1/admin/transactions/sep24/expired/cancel
 *
 * Cierra instrucciones SEP-24 caducadas que nunca recibieron fondos.
 *
 * Body: { transactionIds: string[], reason: string }
 *
 * Deliberadamente NO existe un modo "cerrar todas": el operador debe nombrar cada
 * instrucción. Los controles de seguridad se reevalúan en el servidor sobre el
 * documento fresco — lo que el cliente mande no se toma como verdad — y la
 * transición se hace de forma atómica para que dos operadores concurrentes no
 * puedan cerrar la misma instrucción dos veces.
 *
 * Cada cierre queda en AdminAuditLog dentro de la misma transacción Mongo que la
 * mutación: si la auditoría no se puede escribir, el cierre se revierte.
 */
export async function cancelExpiredSep24(req, res) {
  const { transactionIds, reason } = req.body ?? {};

  if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
    return res.status(400).json({
      error: 'transactionIds debe ser un arreglo no vacío con los identificadores a cerrar.',
    });
  }
  if (transactionIds.length > 100) {
    return res.status(400).json({ error: 'Máximo 100 instrucciones por llamada.' });
  }
  if (!reason || reason.trim().length < 10) {
    return res.status(400).json({
      error: 'Se requiere una justificación del cierre (mín. 10 caracteres). Ej: "Cierre administrativo: instrucciones caducadas sin recepción de fondos".',
    });
  }

  const justification = reason.trim();
  const now     = new Date();
  const results = [];

  for (const rawId of transactionIds) {
    const tx = await Transaction.findOne(sep24IdFilter(rawId))
      .select('alytoTransactionId status sep24Type originalAmount originCurrency expiresAt stellarTxHash stellarTxId externalTransactionId ipnLog')
      .lean();

    if (!tx) {
      results.push({ id: String(rawId), outcome: 'not_found' });
      continue;
    }

    const { safeToCancel, blockers } = evaluateSep24Closure(tx, now);
    if (!safeToCancel) {
      results.push({
        id: tx.alytoTransactionId ?? String(tx._id),
        outcome: 'skipped',
        blockers,
      });
      continue;
    }

    const statusReason =
      `Instrucción SEP-24 caducada el ${new Date(tx.expiresAt).toISOString().slice(0, 10)} sin recepción de fondos ` +
      `(sin transacción Stellar, sin referencia externa y sin eventos de proveedor). Cierre administrativo. ` +
      `Sin impacto patrimonial para el usuario.`;

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      // Guard atómico: la transición solo procede si el documento sigue en un
      // estado SEP-24 pendiente. Si otro operador ganó la carrera, no hacemos nada.
      const updated = await Transaction.findOneAndUpdate(
        { _id: tx._id, status: { $in: SEP24_PENDING_STATUSES } },
        {
          $set:  { status: 'cancelled', statusReason },
          $push: {
            ipnLog: {
              provider:   'manual',
              eventType:  'sep24_expired_cancelled',
              status:     'cancelled',
              rawPayload: { reason: justification, previousStatus: tx.status },
              receivedAt: now,
            },
          },
        },
        { session, returnDocument: 'after' },
      );

      if (!updated) {
        await session.abortTransaction();
        results.push({
          id: tx.alytoTransactionId ?? String(tx._id),
          outcome: 'skipped',
          blockers: ['otro proceso modificó el estado durante la operación'],
        });
        continue;
      }

      await recordAdminAction({
        req, session,
        action:     'transaction.sep24_expired_cancel',
        targetType: 'Transaction',
        targetId:   tx.alytoTransactionId ?? String(tx._id),
        before:     { status: tx.status, expiresAt: tx.expiresAt },
        after:      { status: 'cancelled', statusReason },
        reason:     justification,
        metadata:   {
          sep24Type: tx.sep24Type ?? null,
          amount:    tx.originalAmount ?? null,
          currency:  tx.originCurrency ?? null,
        },
      });

      await session.commitTransaction();
      results.push({ id: tx.alytoTransactionId ?? String(tx._id), outcome: 'cancelled' });
    } catch (err) {
      await session.abortTransaction().catch(() => {});
      console.error('[Admin cancelExpiredSep24] Error cerrando instrucción:', {
        id: tx.alytoTransactionId ?? String(tx._id), error: err.message,
      });
      results.push({
        id: tx.alytoTransactionId ?? String(tx._id),
        outcome: 'error',
        error:   err.message,
      });
    } finally {
      await session.endSession();
    }
  }

  const cancelled = results.filter((r) => r.outcome === 'cancelled').length;

  console.info('[Admin] Cierre de instrucciones SEP-24 caducadas:', {
    solicitadas: transactionIds.length, cerradas: cancelled, admin: req.user?.email,
  });

  return res.json({
    success:   true,
    requested: transactionIds.length,
    cancelled,
    results,
  });
}

// ─── Registro de accesos ─────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/access-logs
 *
 * Consulta del registro de accesos e intentos de acceso (Art. 2° inc. d, Sec. 4
 * del Reglamento ETF). Sólo lectura: la colección es append-only y no existe vía
 * para alterarla.
 *
 * Mantener los registros sin poder revisarlos no constituye un control, así que
 * esta consulta es parte del cumplimiento y no un accesorio.
 *
 * Query: ?outcome=success|failed|blocked · ?email= · ?userId= · ?days=N · ?limit=N
 */
export async function listAccessLogs(req, res) {
  const AccessLog = (await import('../models/AccessLog.js')).default;

  const filtro = {};
  if (['success', 'failed', 'blocked'].includes(req.query.outcome)) {
    filtro.outcome = req.query.outcome;
  }
  if (req.query.email)  filtro.email  = String(req.query.email).toLowerCase().trim();
  if (req.query.userId) filtro.userId = req.query.userId;

  const days  = Math.min(Math.max(parseInt(req.query.days  ?? '30',  10) || 30,  1), 365);
  const limit = Math.min(Math.max(parseInt(req.query.limit ?? '100', 10) || 100, 1), 500);
  filtro.createdAt = { $gte: new Date(Date.now() - days * 86_400_000) };

  try {
    const [items, resumen] = await Promise.all([
      AccessLog.find(filtro).sort({ createdAt: -1 }).limit(limit).lean(),
      AccessLog.aggregate([
        { $match: filtro },
        { $group: { _id: '$outcome', n: { $sum: 1 } } },
      ]),
    ]);

    return res.json({
      success:     true,
      ventanaDias: days,
      // El total por resultado deja ver de un vistazo si hay una racha de fallos
      // concentrada, que es la señal que interesa vigilar.
      resumen: Object.fromEntries(resumen.map((r) => [r._id, r.n])),
      count:   items.length,
      items,
    });
  } catch (err) {
    console.error('[Admin listAccessLogs] Error:', err.message);
    return res.status(500).json({ error: 'Error al consultar el registro de accesos.' });
  }
}
