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
    // Expresada como CLP por 1 BOB (ej: 99.59 → 1 BOB = 99.59 CLP)
    // Se calcula: precio_compra_USDT_CLP / precio_venta_USDT_BOB
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
