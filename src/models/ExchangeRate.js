/**
 * ExchangeRate.js — Tasas de Cambio Configurables desde Admin
 *
 * Almacena una tasa activa por par de monedas (unique index en `pair`).
 * El admin actualiza la tasa manualmente después de comprar USDC en Binance P2P
 * u otro exchange. Se guarda la tasa anterior en `previousRate` para auditoría.
 *
 * Pares de uso principal:
 *   BOB-USDT / BOB-USD  — Bolivia: BOB por 1 USDC (ej. 9.31)
 *   CLP-USD             — Chile: CLP por 1 USD (referencial, Vita lo actualiza)
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

const exchangeRateSchema = new Schema(
  {
    /**
     * Identificador del par. Formato: "{originCurrency}-{targetCurrency}".
     * Ej: "BOB-USDT", "BOB-USD", "CLP-USD"
     */
    pair: {
      type:     String,
      required: true,
      unique:   true,
      trim:     true,
      uppercase: true,
    },

    /**
     * Tasa actual: unidades de originCurrency por 1 unidad de targetCurrency.
     * Ej: 9.31 significa 9.31 BOB = 1 USDT.
     */
    rate: {
      type:     Number,
      required: true,
      min:      0,
    },

    /**
     * Tasa anterior (guardada automáticamente antes de cada actualización).
     */
    previousRate: {
      type:    Number,
      default: null,
    },

    /**
     * Origen del dato de la tasa.
     *   manual       — Ingresada manualmente por el admin
     *   binance_p2p  — Extraída de una orden Binance P2P
     *   api          — Obtenida de una API de precios externa
     */
    source: {
      type:    String,
      enum:    ['manual', 'binance_p2p', 'api', 'calculated'],
      default: 'manual',
    },

    /**
     * Admin que realizó la última actualización.
     */
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref:  'User',
    },

    /**
     * Nota descriptiva del ajuste.
     * Ej: "Compra Binance P2P orden #12345 — 500 USDT a 9.31 BOB/USDT"
     */
    note: {
      type:  String,
      trim:  true,
    },
  },
  {
    timestamps:  true,
    collection:  'exchangerates',
  },
);

// Índice único: solo una tasa activa por par
exchangeRateSchema.index({ pair: 1 }, { unique: true });

const ExchangeRate = mongoose.model('ExchangeRate', exchangeRateSchema);

export default ExchangeRate;
