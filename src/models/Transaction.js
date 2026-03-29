/**
 * Transaction.js — Modelo de Transacción Web3 Multi-Entidad
 *
 * Registra el ciclo de vida completo de un crossBorderPayment:
 * desde el pay-in fiat hasta la liquidación en Stellar y el off-ramp final.
 *
 * Terminología de compliance aplicada (términos prohibidos ausentes):
 *   crossBorderPayment, payin, payout, liquidation, fxConversion
 *
 * El campo `legalEntity` (heredado del usuario) determina qué reglas de
 * compliance aplican al registrar y auditar esta transacción.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

// ─── Sub-esquema: Fees Granulares por Corredor ───────────────────────────────
// Calculados en initCrossBorderPayment desde TransactionConfig.
// Se desnormalizan aquí para que cambios futuros de config no alteren el historial.

const feesSchema = new Schema(
  {
    /** Fee del proveedor de payin trasladada al usuario (ej. Fintoc %) */
    payinFee:        { type: Number, default: 0 },
    /** Spread cambiario de Alyto (% sobre el originAmount) */
    alytoCSpread:    { type: Number, default: 0 },
    /** Fee fija por operación en moneda de origen */
    fixedFee:        { type: Number, default: 0 },
    /** Fee fija del proveedor de payout (ej. Vita, en moneda destino) */
    payoutFee:       { type: Number, default: 0 },
    /** Margen de ganancia retenido por Alyto (% sobre el originAmount) */
    profitRetention: { type: Number, default: 0 },
    /** Total visible para el usuario (sin profitRetention) */
    totalDeducted:     { type: Number, default: 0 },
    /** Total real descontado incluyendo profitRetention (uso interno/auditoría) */
    totalDeductedReal: { type: Number, default: 0 },
    /** Moneda en que se expresan los fees */
    feeCurrency:       { type: String, default: 'CLP' },
  },
  { _id: false },
);

// ─── Sub-esquema: Conversión de Moneda (SRL Bolivia) ─────────────────────────
// Registra la conversión BOB→USD aplicada antes del payout a Vita.
// Tipo de cambio fijo ASFI: 1 USD = 6.96 BOB (configurable via BOB_USD_RATE).

const conversionRateSchema = new Schema(
  {
    fromCurrency:    { type: String },          // 'BOB'
    toCurrency:      { type: String },          // 'USD'
    rate:            { type: Number },          // 6.96
    convertedAmount: { type: Number },          // monto en USD enviado a Vita
  },
  { _id: false },
);

// ─── Sub-esquema: Desglose de Fees (legacy) ──────────────────────────────────

const feeBreakdownSchema = new Schema(
  {
    /** Fee cobrada por Alyto sobre el monto (en moneda de origen) */
    alytoFee: {
      type:    Number,
      default: 0,
    },
    /** Fee del proveedor de pay-in (Stripe, Fintoc, etc.) */
    providerFee: {
      type:    Number,
      default: 0,
    },
    /** Fee de red Stellar en XLM (asumida por channelAccount, informativa) */
    networkFee: {
      type:    Number,
      default: 0,
    },
    /** Fee total aplicada al usuario */
    totalFee: {
      type:    Number,
      default: 0,
    },
    /** Moneda en que se expresan las fees */
    feeCurrency: {
      type:  String,
      trim:  true,
    },
  },
  { _id: false },
);

// ─── Sub-esquema: Leg de Pago ─────────────────────────────────────────────────
// Un "leg" representa una etapa del flujo (payin, transit, payout)

const paymentLegSchema = new Schema(
  {
    /** Etapa del flujo */
    stage: {
      type: String,
      enum: ['payin', 'transit', 'payout'],
    },
    /** Proveedor que ejecutó esta etapa */
    provider: {
      type: String,
      enum: ['stripe', 'fintoc', 'owlPay', 'stellar', 'anchorBolivia', 'vitaWallet', 'rampNetwork', 'manual'],
    },
    /** Status de esta etapa específica */
    status: {
      type:    String,
      enum:    ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
    },
    /** ID externo del proveedor para esta etapa (ej. Stripe PaymentIntent ID) */
    externalId: {
      type:  String,
      trim:  true,
    },
    /** Timestamp de completado */
    completedAt: {
      type: Date,
    },
    /** Mensaje de error si falló */
    errorMessage: {
      type: String,
    },
  },
  { _id: false },
);

// ─── Sub-esquema: Beneficiario ────────────────────────────────────────────────
// Datos del destinatario final del pago. Guardados en la transacción para
// auditoría AML aunque el perfil del usuario cambie después.

const beneficiarySchema = new Schema(
  {
    firstName: { type: String, trim: true },
    lastName:  { type: String, trim: true },
    email:     { type: String, trim: true, lowercase: true },
    /** Número de teléfono del beneficiario (requerido para algunos métodos, ej. Nequi) */
    phone:     { type: String, trim: true },

    // ── Documento de identidad ──────────────────────────────────────────────
    documentType:   { type: String, trim: true },  // ej. 'ci', 'rut', 'dni', 'cuit'
    documentNumber: { type: String, trim: true },

    // ── Datos bancarios (campos dinámicos por país según withdrawal_rules) ──
    /** Código del banco (ej. '0009' para Banco de Chile) */
    bankCode:    { type: String, trim: true },
    /** Número de cuenta bancaria */
    accountBank: { type: String, trim: true },
    /** Tipo de cuenta bancaria (ej. 'checking', 'savings', 'vista') */
    accountType: { type: String, trim: true },
    /** Dirección postal del beneficiario (requerida para algunos países) */
    address:     { type: String, trim: true },

    // ── Campos adicionales dinámicos del país ───────────────────────────────
    /**
     * Mapa de campos dinámicos que varían por corredor (vienen de withdrawal_rules).
     * Ej: { "clabe": "012345678901234567" } para MX, { "pix_key": "..." } para BR.
     */
    dynamicFields: {
      type:    Map,
      of:      String,
      default: {},
    },
  },
  { _id: false },
);

// ─── Sub-esquema: Entrada del Log de IPN ─────────────────────────────────────
// Registra cada webhook/IPN recibido de los proveedores para auditoría y
// facilitar el debugging en caso de notificaciones duplicadas o fuera de orden.

const ipnLogEntrySchema = new Schema(
  {
    /** Proveedor que envió la notificación */
    provider: {
      type: String,
      enum: ['stripe', 'fintoc', 'owlPay', 'vitaWallet', 'anchorBolivia', 'rampNetwork', 'stellar', 'system', 'manual'],
    },
    /** Tipo de evento tal como lo reportó el proveedor (ej. 'payment.completed') */
    eventType: { type: String, trim: true },
    /** Status reportado por el proveedor en esta notificación */
    status:    { type: String, trim: true },
    /** Payload completo del webhook (guardado para debugging y replay) */
    rawPayload: {
      type: Schema.Types.Mixed,
    },
    /** Timestamp de recepción del webhook en nuestros servidores */
    receivedAt: {
      type:    Date,
      default: Date.now,
    },
  },
  { _id: false },
);

// ─── Sub-esquema: Datos de Compliance Bolivia ────────────────────────────────
// Solo aplica cuando legalEntity = 'SRL' (Escenario C)

const boliviaComplianceSchema = new Schema(
  {
    /** URL del PDF del Comprobante Oficial de Transacción en S3 */
    comprobantePdfUrl: {
      type:  String,
      trim:  true,
    },
    /** Timestamp de generación del comprobante */
    comprobanteGeneratedAt: {
      type: Date,
    },
    /** NIT o CI del cliente boliviano para el comprobante */
    clientTaxId: {
      type:  String,
      trim:  true,
    },
    /** Monto expresado en BOB para el comprobante */
    amountBob: {
      type: Number,
    },
    /** Tipo de cambio BOB/USD usado en el comprobante */
    exchangeRateBob: {
      type: Number,
    },
  },
  { _id: false },
);

// ─── Esquema Principal: Transaction ──────────────────────────────────────────

const transactionSchema = new Schema(
  {
    // ── Referencia al usuario ────────────────────────────────────────────────
    userId: {
      type:     Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },

    // ── Corredor de pago aplicado ─────────────────────────────────────────────
    /**
     * Referencia al TransactionConfig que define el spread y los fees de esta
     * transacción. Se guarda el ObjectId para trazabilidad; los valores
     * económicos (spread, fees) se desnormalizan en feeBreakdown para que
     * un cambio futuro de config no altere el registro histórico.
     */
    corridorId: {
      type:  Schema.Types.ObjectId,
      ref:   'TransactionConfig',
      index: true,
    },

    // ── Jurisdicción (heredada del usuario, desnormalizada para auditoría) ──
    /**
     * Entidad legal que procesó esta transacción.
     * Desnormalizado desde User.legalEntity para auditoría independiente:
     * si el usuario cambia de entidad, las transacciones históricas mantienen
     * su registro correcto.
     */
    legalEntity: {
      type:     String,
      enum:     ['LLC', 'SpA', 'SRL'],
      required: true,
    },

    // ── Tipo de operación ────────────────────────────────────────────────────
    operationType: {
      type:     String,
      enum:     ['crossBorderPayment', 'b2bTransfer', 'payin', 'payout', 'fxConversion', 'tokenization', 'liquidation'],
      required: true,
    },

    /** Escenario de enrutamiento aplicado (A=LLC Global, B=SpA Chile, C=SRL Bolivia, D=LLC LatAm) */
    routingScenario: {
      type:  String,
      enum:  ['A', 'B', 'C', 'D'],
    },

    // ── Montos Fiat ───────────────────────────────────────────────────────────
    /** Monto original enviado por el usuario (en moneda de origen) */
    originalAmount: {
      type:     Number,
      required: true,
      min:      0,
    },
    /** ISO 4217 — moneda de origen del usuario (ej. 'USD', 'CLP', 'BOB') */
    originCurrency: {
      type:      String,
      required:  true,
      uppercase: true,
      trim:      true,
      minlength: 3,
      maxlength: 3,
    },
    /** Monto que recibe el destinatario (en moneda de destino, después de fees) */
    destinationAmount: {
      type: Number,
      min:  0,
    },
    /** ISO 4217 — moneda de destino */
    destinationCurrency: {
      type:      String,
      uppercase: true,
      trim:      true,
      minlength: 3,
      maxlength: 3,
    },

    // ── Activo Digital en Stellar ─────────────────────────────────────────────
    /** Código del activo usado para el tránsito en Stellar (ej. 'USDC', 'XLM') */
    digitalAsset: {
      type:  String,
      trim:  true,
      enum:  ['USDC', 'XLM'],    // Solo assets activos — CLPX y BP Ventures pausados
    },
    /** Monto del activo digital en tránsito */
    digitalAssetAmount: {
      type: Number,
      min:  0,
    },

    // ── Tipo de Cambio ────────────────────────────────────────────────────────
    /** Tipo de cambio aplicado: 1 [originCurrency] = exchangeRate [destinationCurrency] */
    exchangeRate: {
      type: Number,
      min:  0,
    },
    /** Timestamp en que se fijó el tipo de cambio */
    exchangeRateLockedAt: {
      type: Date,
    },

    // ── Fees ──────────────────────────────────────────────────────────────────
    /** Desglose granular de fees calculado desde TransactionConfig al crear la tx */
    fees: {
      type: feesSchema,
    },
    /** Desglose legacy — mantenido para compatibilidad con transacciones anteriores */
    feeBreakdown: {
      type: feeBreakdownSchema,
    },

    // ── Direcciones Stellar ───────────────────────────────────────────────────
    /** Stellar public key de la cuenta origen en la transacción */
    stellarSourceAddress: {
      type:  String,
      trim:  true,
      match: /^G[A-Z2-7]{55}$/,
    },
    /** Stellar public key de la cuenta destino en la transacción */
    stellarDestAddress: {
      type:  String,
      trim:  true,
      match: /^G[A-Z2-7]{55}$/,
    },
    /**
     * Hash de la transacción confirmada en Stellar Network (TXID).
     * Clave para trazabilidad blockchain y generación de Comprobante Bolivia (Escenario C).
     */
    stellarTxId: {
      type: String,
      trim: true,
    },

    /**
     * Conversión de moneda aplicada en el payout (solo corredores SRL/BOB).
     * Registra la tasa BOB→USD utilizada al momento del payout a Vita.
     */
    conversionRate: { type: conversionRateSchema },

    /**
     * Instrucciones de payin manual (solo corredores con payinMethod: 'manual').
     * Guardadas en BD para que el usuario pueda consultarlas desde TransactionDetail.
     */
    paymentInstructions: { type: Schema.Types.Mixed },
    /**
     * QR de pago generado para corredores manuales (SRL Bolivia).
     * Base64 data URL (image/png) — incrustar directo en <img src="..."> o email.
     */
    paymentQR: { type: String },
    /**
     * Detalles de la confirmación manual del payin (rellenado por el admin).
     * Solo en corredores con payinMethod: 'manual'.
     */
    confirmationDetails: {
      type: new Schema({
        confirmedBy:      { type: Schema.Types.ObjectId, ref: 'User' },
        confirmedAt:      { type: Date },
        confirmationNote: { type: String, trim: true },
        bankReference:    { type: String, trim: true },
      }, { _id: false }),
    },
    /**
     * Comprobante de pago subido por el usuario (solo corredores manuales SRL).
     * Guardado en BD como base64 para no requerir almacenamiento externo.
     * Máximo 5 MB — solo JPG, PNG o PDF.
     */
    paymentProof: {
      type: new Schema({
        data:       { type: String },       // base64
        mimetype:   { type: String },       // 'image/jpeg' | 'image/png' | 'application/pdf'
        filename:   { type: String, trim: true },
        size:       { type: Number },       // bytes
        uploadedAt: { type: Date, default: Date.now },
      }, { _id: false }),
    },
    /** Ledger de Stellar en que se confirmó la transacción */
    stellarLedger: {
      type: Number,
    },

    // ── Países ───────────────────────────────────────────────────────────────
    /** ISO 3166-1 alpha-2 — país de origen de los fondos */
    originCountry: {
      type:      String,
      uppercase: true,
      trim:      true,
      minlength: 2,
      maxlength: 2,
    },
    /** ISO 3166-1 alpha-2 — país de destino de los fondos */
    destinationCountry: {
      type:      String,
      uppercase: true,
      trim:      true,
      minlength: 2,
      maxlength: 2,
    },

    // ── Flujo de Proveedores ──────────────────────────────────────────────────
    /**
     * Registro de los proveedores que ejecutaron cada etapa del flujo.
     * Permite auditar si se usó el proveedor primario o un fallback.
     * Ejemplo: ['payin:fintoc', 'transit:stellar', 'payout:anchorBolivia']
     */
    providersUsed: {
      type:    [String],
      default: [],
    },
    /** Desglose detallado por etapa del flujo */
    paymentLegs: {
      type:    [paymentLegSchema],
      default: [],
    },

    // ── Estado Global de la Transacción ──────────────────────────────────────
    status: {
      type:    String,
      enum:    ['pending', 'initiated', 'payin_pending', 'payin_confirmed', 'payin_completed', 'processing', 'in_transit', 'payout_pending', 'payout_sent', 'completed', 'failed', 'refunded'],
      default: 'pending',
      index:   true,
    },
    /** Mensaje de error si status = 'failed' */
    failureReason: {
      type: String,
    },
    /** Timestamp de completado final */
    completedAt: {
      type: Date,
    },

    // ── Beneficiario ──────────────────────────────────────────────────────────
    /**
     * Datos del destinatario final del pago.
     * Desnormalizados en la transacción para auditoría AML independiente:
     * el registro es inmutable aunque el usuario modifique su perfil.
     */
    beneficiary: {
      type: beneficiarySchema,
    },

    // ── Referencias externas de Payin / Payout ────────────────────────────────
    /**
     * ID externo de la orden de cobro en el proveedor de pay-in.
     * Ej: PaymentIntent ID de Stripe, orden Fintoc, payment_order de Vita.
     * Permite hacer lookup en el proveedor para verificar estado o hacer refund.
     */
    payinReference: {
      type:  String,
      trim:  true,
      index: true,
      sparse: true,
    },
    /**
     * ID externo del retiro/dispersión en el proveedor de pay-out.
     * Ej: transaction ID de Vita Wallet, referencia del Anchor Bolivia.
     */
    payoutReference: {
      type:   String,
      trim:   true,
      index:  true,
      sparse: true,
    },

    // ── Log de Notificaciones IPN ─────────────────────────────────────────────
    /**
     * Registro cronológico de todos los webhooks / IPN recibidos de los
     * proveedores durante el ciclo de vida de esta transacción.
     * Permite auditar el flujo completo y hacer replay en caso de error.
     */
    ipnLog: {
      type:    [ipnLogEntrySchema],
      default: [],
    },

    // ── Compliance Bolivia (solo Escenario C — legalEntity = 'SRL') ───────────
    boliviaCompliance: {
      type: boliviaComplianceSchema,
    },

    // ── Metadatos ─────────────────────────────────────────────────────────────
    /** ID interno generado por el orquestador (ALY-{scenario}-{ts}-{random}) */
    alytoTransactionId: {
      type: String,
    },
    /** Notas internas de operaciones (no visibles al usuario) */
    internalNotes: {
      type: String,
    },
    /** IP de origen de la solicitud (para auditoría de fraude) */
    clientIp: {
      type: String,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt automáticos
    collection: 'transactions',
  },
);

// ─── Índices compuestos para consultas frecuentes ────────────────────────────

transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ legalEntity: 1, status: 1 });
transactionSchema.index({ legalEntity: 1, createdAt: -1 });
transactionSchema.index({ corridorId: 1, createdAt: -1 });
transactionSchema.index({ stellarTxId: 1 }, { sparse: true });
transactionSchema.index({ alytoTransactionId: 1 }, { unique: true, sparse: true });


const Transaction = mongoose.model('Transaction', transactionSchema);

export default Transaction;
