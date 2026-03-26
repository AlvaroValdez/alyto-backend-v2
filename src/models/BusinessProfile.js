/**
 * BusinessProfile.js — Perfil KYB de cuentas Business
 *
 * Una por usuario (unique:true en userId). Se crea cuando el usuario
 * personal (kycStatus: 'approved') solicita activar su cuenta Business.
 *
 * Flujo:
 *   POST /api/v1/kyb/apply → kybStatus: 'pending'
 *   Admin revisa → 'under_review' → 'approved' | 'rejected' | 'more_info'
 *   Si 'approved' → User.accountType = 'business', habilita corredores OwlPay
 */

import mongoose from 'mongoose';
import crypto   from 'crypto';

const { Schema } = mongoose;

// ─── Sub-esquema: Representante Legal ────────────────────────────────────────

const legalRepresentativeSchema = new Schema(
  {
    firstName:      { type: String, trim: true },
    lastName:       { type: String, trim: true },
    documentType:   { type: String, trim: true },
    documentNumber: { type: String, trim: true },
    email:          { type: String, lowercase: true, trim: true },
    phone:          { type: String, trim: true },
  },
  { _id: false },
);

// ─── Sub-esquema: Documento KYB ──────────────────────────────────────────────

const kybDocumentSchema = new Schema(
  {
    /** Categoría del documento para revisión de compliance */
    type: {
      type: String,
      enum: [
        'tax_certificate',    // RUT / NIT / EIN — certificado tributario
        'incorporation_deed', // Escritura de constitución
        'legal_rep_id',       // CI / pasaporte del representante legal
        'address_proof',      // Comprobante de domicilio
        'bank_statement',     // Estado de cuenta bancario
        'other',
      ],
    },
    filename:   { type: String },
    /** Contenido del archivo en base64 — almacenado en BD hasta migración a S3 */
    data:       { type: String, select: false },   // excluido por defecto en queries
    mimetype:   { type: String },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

// ─── Sub-esquema: Límites Operativos ─────────────────────────────────────────

const transactionLimitsSchema = new Schema(
  {
    /** Monto máximo por operación individual (USD) */
    maxSingleTransaction: { type: Number, default: 50_000 },
    /** Volumen máximo mensual acumulado (USD) */
    maxMonthlyVolume:     { type: Number, default: 80_000 },
    currency:             { type: String, default: 'USD' },
  },
  { _id: false },
);

// ─── Esquema Principal: BusinessProfile ──────────────────────────────────────

const businessProfileSchema = new Schema(
  {
    // ── Relación con Usuario ─────────────────────────────────────────────────
    userId: {
      type:     Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      unique:   true,
    },
    /**
     * ID de referencia pública — formato "BIZ-XXXXXXXX".
     * Se genera al momento de creación y es inmutable.
     * Usado en emails y en el panel de admin para búsqueda rápida.
     */
    businessId: {
      type:    String,
      unique:  true,
    },

    // ── Datos de la Empresa ──────────────────────────────────────────────────
    /** Razón social completa tal como aparece en la escritura de constitución */
    legalName:               { type: String, trim: true },
    /** Nombre comercial o marca (puede diferir de la razón social) */
    tradeName:               { type: String, trim: true },
    /** RUT / NIT / EIN — número de identificación tributaria */
    taxId:                   { type: String, trim: true },
    /** ISO 3166-1 alpha-2 — país donde fue constituida la empresa */
    countryOfIncorporation:  { type: String, uppercase: true, trim: true, maxlength: 2 },
    businessType: {
      type: String,
      enum: [
        'sole_proprietor', // Persona natural con actividad comercial
        'llc',             // SRL / LLC
        'corporation',     // SA / Corp / PLC
        'partnership',     // Sociedad de personas / Colectiva
        'ngo',             // ONG / Fundación
      ],
    },
    industry:  { type: String, trim: true },
    website:   { type: String, trim: true },
    phone:     { type: String, trim: true },
    address:   { type: String, trim: true },
    city:      { type: String, trim: true },
    country:   { type: String, uppercase: true, trim: true, maxlength: 2 },

    // ── Representante Legal ──────────────────────────────────────────────────
    legalRepresentative: {
      type:    legalRepresentativeSchema,
      default: null,
    },

    // ── Perfil de Riesgo / Volumen ───────────────────────────────────────────
    estimatedMonthlyVolume: {
      type: String,
      enum: [
        'under_5k',  // < $5.000 USD
        '5k_20k',    // $5.000 – $20.000 USD
        '20k_60k',   // $20.000 – $60.000 USD
        'over_60k',  // > $60.000 USD
      ],
    },
    /** Corredores de interés declarados por el usuario — ej. ["BO-US", "BO-EU"] */
    mainCorridors:       { type: [String], default: [] },
    businessDescription: { type: String, trim: true },

    // ── Documentos KYB ──────────────────────────────────────────────────────
    documents: {
      type:    [kybDocumentSchema],
      default: [],
    },

    // ── Estado KYB ──────────────────────────────────────────────────────────
    kybStatus: {
      type:    String,
      enum:    ['pending', 'under_review', 'approved', 'rejected', 'more_info'],
      default: 'pending',
    },
    /** Admin que realizó la revisión */
    kybReviewedBy:  { type: Schema.Types.ObjectId, ref: 'User', default: null },
    kybReviewedAt:  { type: Date, default: null },
    /** Comentario interno del admin visible al usuario */
    kybNote:        { type: String, trim: true, default: null },
    /** Razón de rechazo — enviada al usuario por email */
    kybRejectionReason: { type: String, trim: true, default: null },

    // ── Límites Operativos ───────────────────────────────────────────────────
    transactionLimits: {
      type:    transactionLimitsSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
    collection: 'business_profiles',
  },
);

// ─── Índices ──────────────────────────────────────────────────────────────────

businessProfileSchema.index({ businessId: 1 });
businessProfileSchema.index({ kybStatus: 1 });
businessProfileSchema.index({ countryOfIncorporation: 1 });

// ─── Hook: generar businessId antes de guardar ────────────────────────────────

businessProfileSchema.pre('save', async function () {
  if (!this.businessId) {
    const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    this.businessId = `BIZ-${suffix}`;
  }
});

const BusinessProfile = mongoose.model('BusinessProfile', businessProfileSchema);

export default BusinessProfile;
