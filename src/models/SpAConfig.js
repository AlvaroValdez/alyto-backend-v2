/**
 * SpAConfig.js — Configuración SpA Chile para payin manual CLP
 *
 * Almacena datos bancarios de AV Finance SpA y la tasa CLP/BOB
 * para el corredor manual CL→BO.
 *
 * La tasa clpPerBob se calcula como:
 *   precio_compra_USDT_CLP / precio_venta_USDT_BOB
 *   Ejemplo: 927.17 / 9.31 = 99.59
 */

import mongoose from 'mongoose';

const spAConfigSchema = new mongoose.Schema(
  {
    // ── Datos bancarios SpA para payin manual CLP ─────────────────────────
    bankName: { type: String, default: '' },
    accountType: {
      type: String,
      enum: ['Cuenta Corriente', 'Cuenta Vista', 'Cuenta de Ahorro'],
      default: 'Cuenta Corriente',
    },
    accountNumber: { type: String, default: '' },
    rut:           { type: String, default: '' },
    accountHolder: { type: String, default: process.env.SPA_ACCOUNT_HOLDER || 'AV Finance SpA' },
    bankEmail:     { type: String, default: '' },

    // ── Tasa CLP/BOB ─────────────────────────────────────────────────────
    // clpPerUsdt: precio compra USDT en CLP (Binance P2P). Ej: 926.82
    clpPerUsdt: { type: Number, default: null },
    // usdtPerBob: precio venta USDT en BOB (Binance P2P). Ej: 9.31
    usdtPerBob: { type: Number, default: null },
    // clpPerBob: CLP por 1 BOB = clpPerUsdt / usdtPerBob. Ej: 99.55
    clpPerBob: { type: Number, default: null },

    /**
     * Quién fijó `clpPerBob` por última vez.
     *
     * Existe porque esta tasa era 100% manual y eso la dejó congelada cinco
     * meses: se cargó bien en mayo de 2026 y quedó 14% desviada cuando el
     * boliviano se movió. Ahora `refreshExchangeRates` la sincroniza sola, pero
     * un admin puede fijarla a mano poniendo 'manual' y el job deja de tocarla.
     */
    rateSource:    { type: String, enum: ['manual', 'binance_p2p_auto'], default: null },
    rateUpdatedAt: { type: Date, default: null },

    // ── Limites del corredor cl-bo ────────────────────────────────────────
    minAmountCLP: { type: Number, default: 10000 },
    maxAmountCLP: { type: Number, default: 5000000 },

    isActive:  { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, collection: 'spaconfigs' },
);

export default mongoose.model('SpAConfig', spAConfigSchema);
