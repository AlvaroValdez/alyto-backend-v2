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
    accountHolder: { type: String, default: 'AV Finance SpA' },
    bankEmail:     { type: String, default: '' },

    // ── Tasa CLP/BOB ─────────────────────────────────────────────────────
    // clpPerUsdt: precio compra USDT en CLP (Binance P2P). Ej: 926.82
    clpPerUsdt: { type: Number, default: null },
    // usdtPerBob: precio venta USDT en BOB (Binance P2P). Ej: 9.31
    usdtPerBob: { type: Number, default: null },
    // clpPerBob: CLP por 1 BOB = clpPerUsdt / usdtPerBob. Ej: 99.55
    clpPerBob: { type: Number, default: 99.59 },

    // ── Limites del corredor cl-bo ────────────────────────────────────────
    minAmountCLP: { type: Number, default: 10000 },
    maxAmountCLP: { type: Number, default: 5000000 },

    isActive:  { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export default mongoose.model('SpAConfig', spAConfigSchema);
