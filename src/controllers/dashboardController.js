/**
 * dashboardController.js — Datos agregados del Dashboard principal
 *
 * GET /api/v1/dashboard
 * Requiere: protect (JWT válido)
 *
 * Retorna en una sola llamada:
 *  - Perfil básico del usuario autenticado
 *  - Stats: totalSent, totalTransactions, completedTransactions, activeTransactions
 *  - Últimas 3 transacciones (recentTransactions)
 *  - Corredores activos disponibles (availableCorridors)
 */

import Transaction       from '../models/Transaction.js';
import TransactionConfig from '../models/TransactionConfig.js';
import { ENTITY_CURRENCY_MAP } from '../utils/entityMaps.js';

// Statuses que representan una operación en curso (no terminal)
const ACTIVE_STATUSES = [
  'initiated',
  'payin_pending',
  'payin_confirmed',
  'payin_completed',
  'processing',
  'in_transit',
  'payout_pending',
  'payout_sent',
];

/**
 * Construye el nombre completo del beneficiario desde los campos disponibles.
 * Prioridad: firstName+lastName → dynamicFields → '—'
 */
function buildBeneficiaryName(beneficiary) {
  if (!beneficiary) return '—';

  const { firstName, lastName, dynamicFields } = beneficiary;

  if (firstName) {
    return `${firstName} ${lastName ?? ''}`.trim();
  }

  // dynamicFields es un Map en Mongoose; con .lean() queda como objeto plano
  if (dynamicFields && typeof dynamicFields === 'object') {
    const dm = dynamicFields instanceof Map
      ? Object.fromEntries(dynamicFields)
      : dynamicFields;
    const nameVal = dm.nombre || dm.name || dm.fullName;
    if (nameVal) return String(nameVal);
  }

  return '—';
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function getDashboard(req, res) {
  try {
    const userId = req.user._id;
    const { firstName, lastName, legalEntity, kycStatus } = req.user;

    const userOriginCurrency = ENTITY_CURRENCY_MAP[legalEntity] ?? 'USD';

    // Ejecutar todas las consultas en paralelo para minimizar latencia
    const [
      totalSentAgg,
      totalTransactions,
      completedTransactions,
      activeTransactions,
      recentTransactions,
      corridors,
    ] = await Promise.all([

      // Suma del monto de origen en transacciones completadas
      Transaction.aggregate([
        { $match: { userId, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$originalAmount' } } },
      ]),

      Transaction.countDocuments({ userId }),

      Transaction.countDocuments({ userId, status: 'completed' }),

      Transaction.countDocuments({ userId, status: { $in: ACTIVE_STATUSES } }),

      // Últimas 3 transacciones ordenadas por fecha de creación
      Transaction
        .find({ userId })
        .sort({ createdAt: -1 })
        .limit(3)
        .select('alytoTransactionId status originalAmount originCurrency destinationAmount destinationCurrency beneficiary createdAt')
        .lean(),

      // Corredores activos filtrados por moneda de origen del usuario
      TransactionConfig
        .find({
          originCurrency: userOriginCurrency,
          isActive:       true,
          originCountry:  { $ne: 'ANY' },
          destinationCountry: { $ne: 'CRYPTO' },
        })
        .select('_id corridorId originCountry destinationCountry originCurrency destinationCurrency')
        .lean(),
    ]);

    const totalSent = totalSentAgg[0]?.total ?? 0;

    // Formatear transacciones recientes
    const formattedTransactions = recentTransactions.map((tx) => ({
      transactionId:       tx.alytoTransactionId ?? tx._id,
      alytoTransactionId:  tx.alytoTransactionId ?? null,
      status:              tx.status,
      originAmount:        tx.originalAmount,
      originCurrency:      tx.originCurrency,
      destinationAmount:   tx.destinationAmount  ?? null,
      destinationCurrency: tx.destinationCurrency ?? null,
      beneficiary: {
        fullName: buildBeneficiaryName(tx.beneficiary),
      },
      createdAt: tx.createdAt,
    }));

    // Formatear corredores
    const formattedCorridors = corridors.map((c) => ({
      corridorId:          c._id,
      originCountry:       c.originCountry,
      destinationCountry:  c.destinationCountry,
      originCurrency:      c.originCurrency,
      destinationCurrency: c.destinationCurrency,
    }));

    res.json({
      user: {
        firstName,
        lastName,
        entity:    legalEntity,
        kycStatus,
      },
      stats: {
        totalSent,
        totalTransactions,
        completedTransactions,
        activeTransactions,
      },
      recentTransactions: formattedTransactions,
      availableCorridors: formattedCorridors,
    });

  } catch (err) {
    console.error('[Dashboard] Error al cargar datos:', err.message);
    res.status(500).json({ error: 'Error al cargar el dashboard.' });
  }
}
