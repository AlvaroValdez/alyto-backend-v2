/**
 * TransactionConfig.js — Configuración de Corredores de Pago
 *
 * Define los parámetros económicos y operativos de cada corredor soportado:
 * origen → destino, spread de Alyto, fees de proveedores y entidad legal.
 *
 * Un "corredor" es una combinación única de:
 *   (originCountry, destinationCountry, originCurrency, destinationCurrency,
 *    payinMethod, payoutMethod)
 *
 * El spread y los fees son configurables desde el backoffice de admin
 * sin redeployar el backend.
 *
 * Ejemplos de corredores activos:
 *   CL → BO | CLP → BOB | payin:fintoc       | payout:anchorBolivia  (Escenario B+C)
 *   US → CO | USD → COP | payin:stripe        | payout:vitaWallet     (Escenario A+D)
 *   AR → BO | ARS → BOB | payin:vitaWallet    | payout:anchorBolivia  (Escenario D+C)
 *   MX → AR | MXN → ARS | payin:vitaWallet    | payout:vitaWallet     (Escenario D)
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

// ─── Esquema Principal: TransactionConfig ────────────────────────────────────

const transactionConfigSchema = new Schema(
  {
    // ── Identificador legible del corredor ────────────────────────────────────
    /**
     * Slug único legible para identificar el corredor.
     * Generado automáticamente: "{originCountry}-{destinationCountry}-{payinMethod}-{payoutMethod}"
     * Ej: "CL-BO-fintoc-anchorBolivia"
     */
    corridorId: {
      type:      String,
      required:  true,
      unique:    true,
      trim:      true,
      lowercase: true,
      index:     true,
    },

    // ── Geografía del corredor ────────────────────────────────────────────────

    /**
     * ISO 3166-1 alpha-2 — país donde se origina el fondeo.
     * Valor especial "ANY" = corredor comodín (acepta cualquier origen).
     */
    originCountry: {
      type:      String,
      required:  true,
      uppercase: true,
      trim:      true,
      minlength: 2,
      maxlength: 6,   // "ANY" + reserva para códigos especiales
    },
    /**
     * ISO 3166-1 alpha-2 — país donde se liquida el pago.
     * Valor especial "CRYPTO" = payout directo a wallet (sin país físico).
     */
    destinationCountry: {
      type:      String,
      required:  true,
      uppercase: true,
      trim:      true,
      minlength: 2,
      maxlength: 6,
    },

    // ── Monedas ───────────────────────────────────────────────────────────────

    /** ISO 4217 — moneda en que el cliente realiza el payin */
    originCurrency: {
      type:      String,
      required:  true,
      uppercase: true,
      trim:      true,
      minlength: 3,
      maxlength: 3,
    },
    /** ISO 4217 — moneda que recibe el beneficiario en destino */
    destinationCurrency: {
      type:      String,
      required:  true,
      uppercase: true,
      trim:      true,
      minlength: 3,
      maxlength: 5,   // soporta stablecoins: USDC, USDT (4 chars)
    },

    // ── Proveedores ───────────────────────────────────────────────────────────

    /** Proveedor utilizado para la etapa de cobro (pay-in) */
    payinMethod: {
      type:     String,
      required: true,
      enum:     ['stripe', 'fintoc', 'owlPay', 'vitaWallet', 'rampNetwork', 'manual'],
    },
    /** Proveedor utilizado para la etapa de dispersión (pay-out / off-ramp) */
    payoutMethod: {
      type:     String,
      required: true,
      enum:     ['vitaWallet', 'anchorBolivia', 'rampNetwork', 'owlPay', 'stellar_direct', 'manual'],
    },
    /**
     * Activo digital usado como vehículo de tránsito en Stellar.
     * Null si el corredor no usa Stellar como capa de tránsito.
     */
    stellarAsset: {
      type:    String,
      enum:    ['USDC', 'XLM', null],
      default: 'USDC',
    },

    // ── Spread y Estructura de Fees ───────────────────────────────────────────

    /**
     * Spread porcentual de Alyto sobre el tipo de cambio de mercado.
     * Expresado en puntos porcentuales: 1.5 = 1.5% sobre el mid-rate.
     * Este margen es la fuente principal de ingresos de Alyto.
     */
    alytoCSpread: {
      type:     Number,
      required: true,
      min:      0,
      max:      20,
      default:  1.5,
    },
    /**
     * Fee fija por transacción cobrada al usuario en moneda de origen.
     * Se suma al monto total antes de calcular el spread.
     * 0 = sin fee fija.
     */
    fixedFee: {
      type:    Number,
      min:     0,
      default: 0,
    },
    /**
     * Fee porcentual del proveedor de pay-in, trasladada al usuario.
     * Expresada en puntos porcentuales: 0.5 = 0.5% del monto de payin.
     * 0 = el costo es absorbido por Alyto.
     */
    payinFeePercent: {
      type:    Number,
      min:     0,
      max:     10,
      default: 0,
    },
    /**
     * Configuración dinámica de fees de Fintoc (solo payinMethod: 'fintoc').
     * Fintoc cobra un fee FIJO por transacción en UF, no un porcentaje.
     * Si fintocConfig.ufValue está presente, el cálculo de payinFee usa
     * calculateFintocFee() en lugar de payinFeePercent.
     * null/ausente = usa payinFeePercent como fallback.
     */
    fintocConfig: {
      /** Valor actual de la UF en CLP. Actualizar mensualmente desde admin. */
      ufValue:     { type: Number, min: 0, default: null },
      /** Tier de volumen Fintoc (1–5). Cambia según txns/mes. */
      tier:        { type: Number, min: 1, max: 5, default: null },
      /** Fecha de última actualización por admin (control de vigencia). */
      lastUpdated: { type: Date, default: null },
    },
    /**
     * Fee fija del proveedor de pay-out (ej. Vita cobra fee por withdrawal).
     * Expresada en moneda de destino.
     * 0 = sin fee fija de payout.
     */
    payoutFeeFixed: {
      type:    Number,
      min:     0,
      default: 0,
    },
    /**
     * Porcentaje del spread de Alyto que se retiene como ganancia neta.
     * El resto puede cubrir costos operativos del corredor.
     * Expresado en puntos porcentuales: 80 = retener 80% del spread como profit.
     */
    profitRetentionPercent: {
      type:    Number,
      min:     0,
      max:     100,
      default: 80,
    },

    /**
     * Tipo de cambio manual fijo para corredores con payinMethod: 'manual'.
     * Expresa cuántas unidades de originCurrency equivalen a 1 USD.
     * Ejemplo para Bolivia: 6.96 (1 USD = 6.96 BOB — tasa oficial ASFI).
     * Se usa en getQuote para calcular BOB→USD antes de aplicar la tasa Vita USD→destino.
     * También se usa en dispatchPayout como referencia de conversión auditada.
     * 0 = no configurado (el sistema usa la variable de entorno BOB_USD_RATE como fallback).
     */
    manualExchangeRate: {
      type:    Number,
      min:     0,
      default: 0,
    },

    /**
     * Proveedor de payout secundario (fallback) si el primario falla.
     * El sistema intenta el payoutMethod principal primero;
     * si lanza excepción, reintenta con este fallback antes de marcar como 'failed'.
     * null = sin fallback configurado (falla directamente).
     */
    fallbackPayoutMethod: {
      type:    String,
      enum:    ['vitaWallet', 'owlPay', 'stellar_direct', 'manual', null],
      default: null,
    },

    // ── Límites Operativos ────────────────────────────────────────────────────

    /**
     * Monto mínimo permitido por transacción, en moneda de origen.
     * Transacciones por debajo de este límite son rechazadas.
     */
    minAmountOrigin: {
      type:    Number,
      min:     0,
      default: 1,
    },
    /**
     * Monto máximo permitido por transacción, en moneda de origen.
     * Null = sin límite superior (sujeto a KYC del usuario).
     */
    maxAmountOrigin: {
      type:    Number,
      default: null,
    },

    // ── Entidad Legal y Escenario de Enrutamiento ─────────────────────────────

    /**
     * Entidad AV Finance que opera este corredor.
     * Determina las obligaciones de compliance aplicables.
     */
    legalEntity: {
      type:     String,
      required: true,
      enum:     ['LLC', 'SpA', 'SRL'],
    },
    /**
     * Escenario de enrutamiento del Multi-Entity Router que usa este corredor.
     * A = LLC Global / B = SpA Chile / C = SRL Bolivia / D = LLC LatAm
     */
    routingScenario: {
      type:     String,
      required: true,
      enum:     ['A', 'B', 'C', 'D'],
    },

    // ── Control de Estado ─────────────────────────────────────────────────────

    /**
     * true = corredor activo y disponible para nuevas transacciones.
     * false = corredor desactivado (mantenimiento o baja de proveedor).
     * El motor de enrutamiento ignora los corredores inactivos.
     */
    isActive: {
      type:    Boolean,
      default: true,
      index:   true,
    },
    /** Notas internas del admin sobre este corredor (motivo de ajustes, etc.) */
    adminNotes: {
      type:  String,
      trim:  true,
    },

    /** Timestamp de baja lógica (null = corredor vigente) */
    deletedAt: {
      type:    Date,
      default: null,
    },

    /**
     * Historial inmutable de cambios realizados desde el backoffice.
     * Cada entrada registra qué campo cambió, quién lo cambió y cuándo.
     */
    changeLog: [
      {
        field:     { type: String },
        oldValue:  { type: Schema.Types.Mixed },
        newValue:  { type: Schema.Types.Mixed },
        changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        changedAt: { type: Date, default: Date.now },
        /**
         * Nota descriptiva obligatoria cuando se modifica manualExchangeRate.
         * Registra el motivo del ajuste (ej. "Tasa ASFI 24/03/2026: 1 USDC = 6.96 BOB").
         */
        note:      { type: String, trim: true },
        _id:       false,
      },
    ],
  },
  {
    timestamps: true, // createdAt, updatedAt automáticos
    collection: 'transaction_configs',
  },
);

// ─── Índices ──────────────────────────────────────────────────────────────────

// Búsqueda de corredores disponibles para un par de países
transactionConfigSchema.index({ originCountry: 1, destinationCountry: 1, isActive: 1 });
// Auditoría y filtrado por entidad legal
transactionConfigSchema.index({ legalEntity: 1, isActive: 1 });
// Búsqueda por par de métodos (para análisis de proveedores)
transactionConfigSchema.index({ payinMethod: 1, payoutMethod: 1 });

// ─── Virtual: descripción humana del corredor ─────────────────────────────────

transactionConfigSchema.virtual('description').get(function () {
  return `${this.originCountry}→${this.destinationCountry} | ${this.originCurrency}→${this.destinationCurrency} | ${this.payinMethod}→${this.payoutMethod}`;
});

const TransactionConfig = mongoose.model('TransactionConfig', transactionConfigSchema);

export default TransactionConfig;
