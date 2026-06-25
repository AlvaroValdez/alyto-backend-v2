/**
 * BankAccount.js — Registro bank-agnostic de cuentas bancarias de tesorería
 *
 * Una fila por cuenta de banco que Alyto opera como tesorería fiduciaria. El
 * objetivo es que sumar un banco nuevo sea agregar una fila (+ un adapter en
 * `bankRegistry`), NO reescribir lógica. Refleja la visión de Alyto como anchor:
 * on-ramp (entrada de fiat) y off-ramp en Bolivia (salida a banco).
 *
 * El campo `provider` resuelve el adapter de código (bankRegistry) que sabe hablar
 * con la API de ese banco. Las `capabilities` declaran qué soporta REALMENTE la API
 * del banco hoy (p. ej. BANECO: saldo+movimientos ✅, dispersión ❌ — confirmado por
 * el banco 2026-06-25), para que el admin no ofrezca acciones que el banco no expone.
 *
 * Este modelo NO guarda saldos (esos viven en el banco y se consultan en vivo vía
 * el adapter). Es el catálogo/configuración de las cuentas.
 */

import mongoose from 'mongoose';

const bankAccountSchema = new mongoose.Schema({
  /** Código interno único de la cuenta (ej. 'BEC-SRL-BOB'). */
  code: {
    type:     String,
    required: true,
    unique:   true,
    index:    true,
  },
  /** Proveedor/banco — resuelve el adapter en bankRegistry (ej. 'baneco'). */
  provider: {
    type:     String,
    required: true,
    index:    true,
  },
  /** Nombre legible del banco (ej. 'Banco Económico'). */
  bankName: {
    type:     String,
    required: true,
  },
  /** Código de entidad financiera (ASFI/interbancario), si aplica. */
  bankCode: {
    type:    String,
    default: null,
  },
  /** Número de cuenta de tesorería en el banco. */
  accountNumber: {
    type:     String,
    required: true,
  },
  /** Tipo de cuenta (ej. 'CA' caja de ahorro, 'CC' corriente). */
  accountType: {
    type:    String,
    default: null,
  },
  /** Moneda de la cuenta (ISO 3-char). */
  currency: {
    type:    String,
    default: 'BOB',
    index:   true,
  },
  /** País de la cuenta (ISO 2-char). */
  country: {
    type:    String,
    default: 'BO',
  },
  /** Entidad legal de Alyto dueña de la cuenta. */
  legalEntity: {
    type:    String,
    enum:    ['SRL', 'SpA', 'LLC'],
    default: 'SRL',
    index:   true,
  },
  /**
   * Roles de la cuenta en el modelo anchor. Una cuenta puede cumplir varios:
   *   - 'onramp'   — recibe fiat de usuarios (payin)
   *   - 'offramp'  — paga fiat a usuarios (payout/dispersión)
   *   - 'treasury' — respaldo fiduciario de saldos de usuarios
   */
  roles: {
    type:    [String],
    enum:    ['onramp', 'offramp', 'treasury'],
    default: ['treasury'],
  },
  /** Qué expone REALMENTE la API del banco hoy (gobierna acciones en el admin). */
  capabilities: {
    balance:   { type: Boolean, default: false },  // §8 queryMovements (saldo)
    movements: { type: Boolean, default: false },  // §8 queryMovements (extracto)
    disburse:  { type: Boolean, default: false },  // §9 dispersión (off-ramp automático)
    payinQr:   { type: Boolean, default: false },  // Pago Simple / BEC QR Connect
  },
  status: {
    type:    String,
    enum:    ['active', 'inactive'],
    default: 'active',
    index:   true,
  },
  /** Notas/configuración extra no estructurada. */
  metadata: {
    type:    mongoose.Schema.Types.Mixed,
    default: {},
  },
}, { timestamps: true });

const BankAccount = mongoose.model('BankAccount', bankAccountSchema);

export default BankAccount;
