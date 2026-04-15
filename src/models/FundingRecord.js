/**
 * FundingRecord.js — Registro de Fondeo Manual de Liquidez
 *
 * Registra cada operación en la que el admin compra USDC (Binance P2P, exchange, etc.)
 * y lo transfiere a la wallet Stellar de la entidad correspondiente.
 *
 * Flujo típico SRL Bolivia:
 *   Admin compra USDC en Binance P2P con BOB
 *   → Transfiere USDC a wallet Stellar de AV Finance SRL
 *   → Registra aquí el fondeo
 *   → El balance disponible aumenta para cubrir payouts pendientes
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

const fundingRecordSchema = new Schema(
  {
    /**
     * ID único legible: FUND-SRL-1710000000000-ABC123
     */
    fundingId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    /**
     * Entidad legal que recibe el fondeo.
     */
    entity: {
      type: String,
      enum: ['LLC', 'SpA', 'SRL'],
      required: true,
    },

    /**
     * Tipo de operación de fondeo.
     *   binance_p2p   — Compra P2P en Binance (BOB→USDC, USD→USDC, etc.)
     *   exchange      — Compra en exchange centralizado
     *   bank_transfer — Transferencia bancaria directa a la entidad
     *   internal      — Movimiento entre wallets/entidades internas de Alyto
     *   other         — Otro tipo de fondeo
     */
    type: {
      type: String,
      enum: ['binance_p2p', 'exchange', 'bank_transfer', 'internal', 'other'],
      required: true,
    },

    /**
     * Activo digital recibido en la wallet Stellar (ej. USDC, USDT, XLM).
     */
    asset: {
      type: String,
      enum: ['USDC', 'USDT', 'XLM', 'USD'],
      required: true,
      default: 'USDC',
    },

    /**
     * Cantidad del activo digital recibida en Stellar.
     */
    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    /**
     * Equivalente en USD al momento del registro (calculado automáticamente).
     * Para USDC/USDT: amount × 1. Para XLM: amount × xlmUsdRate.
     */
    usdEquivalent: {
      type: Number,
      required: true,
      min: 0,
    },

    /**
     * Tasa de cambio aplicada para calcular usdEquivalent.
     * Ej: para XLM → 0.12 USD/XLM. Para USDC → 1.0.
     */
    exchangeRate: {
      type: Number,
      default: 1,
    },

    /**
     * Moneda fiat usada para comprar el activo digital.
     * Ej: 'BOB', 'USD', 'CLP', 'ARS'
     */
    sourceCurrency: {
      type: String,
      trim: true,
      uppercase: true,
    },

    /**
     * Monto en moneda fiat pagado para obtener `amount` de `asset`.
     * Ej: 696 BOB para 100 USDC a tasa 6.96.
     */
    sourceAmount: {
      type: Number,
      min: 0,
    },

    /**
     * TXID de la transacción en la red Stellar (transferencia a la wallet).
     * Permite verificar el fondeo en el explorador de Stellar.
     */
    stellarTxId: {
      type: String,
      trim: true,
    },

    /**
     * ID de la orden en Binance P2P (si aplica).
     */
    binanceOrderId: {
      type: String,
      trim: true,
    },

    /**
     * Referencia de la transferencia bancaria (si aplica).
     */
    bankReference: {
      type: String,
      trim: true,
    },

    /**
     * Nota descriptiva del admin sobre este fondeo.
     */
    note: {
      type: String,
      trim: true,
    },

    /**
     * Admin que registró este fondeo (ref a User con role: 'admin').
     */
    registeredBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    /**
     * Estado del registro.
     *   confirmed  — Fondeo verificado y disponible para payouts
     *   pending    — Registrado pero pendiente de confirmación en Stellar
     *   cancelled  — Cancelado / error de registro
     */
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'cancelled'],
      default: 'confirmed',
    },
  },
  {
    timestamps: true,
    collection: 'fundingrecords',
  },
);

// Índices para consultas del balance por entidad
fundingRecordSchema.index({ entity: 1, asset: 1, status: 1 });
fundingRecordSchema.index({ createdAt: -1 });

/**
 * Devuelve el USDC disponible para payouts de una entidad legal:
 *   disponible = sum(FundingRecord.amount confirmado USDC)
 *                - sum(Transaction.digitalAssetAmount en vuelo para esa entidad)
 *
 * Transacciones "en vuelo" consumen liquidez hasta que Harbor confirma o falla:
 *   payout_pending_usdc_send, payout_in_transit, payout_sent
 *
 * @param {'LLC'|'SpA'|'SRL'} entity
 * @returns {Promise<number>} USDC disponible (>= 0)
 */
fundingRecordSchema.statics.getAvailableUSDC = async function (entity) {
  if (!entity) return 0;

  const [inflowAgg, outflowAgg] = await Promise.all([
    this.aggregate([
      { $match: { entity, asset: 'USDC', status: 'confirmed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    mongoose.model('Transaction').aggregate([
      {
        $match: {
          legalEntity: entity,
          status: { $in: ['payout_pending_usdc_send', 'payout_in_transit', 'payout_sent'] },
        },
      },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$digitalAssetAmount', 0] } } } },
    ]),
  ]);

  const inflow  = inflowAgg[0]?.total  ?? 0;
  const outflow = outflowAgg[0]?.total ?? 0;
  return Math.max(0, inflow - outflow);
};

const FundingRecord = mongoose.model('FundingRecord', fundingRecordSchema);

export default FundingRecord;
