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
    name:           { type: String, trim: true },
    firstName:      { type: String, trim: true },
    lastName:       { type: String, trim: true },
    docType:        { type: String, trim: true },
    documentType:   { type: String, trim: true },
    docNumber:      { type: String, trim: true },
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
        // Frontend keys (KybForm.jsx DOCS_SCHEMA)
        'docTaxId',        // RUT / NIT de la empresa
        'docConstitution', // Escritura de constitución
        'docRepId',        // CI del representante legal
        'docDomicile',     // Comprobante de domicilio
        'docBankStatement',// Estado de cuenta bancaria
        // Legacy values
        'tax_certificate', 'incorporation_deed', 'legal_rep_id',
        'address_proof', 'bank_statement', 'other',
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
//
// Los límites se expresan en la moneda nativa de la entidad:
//   SpA / LLC → USD  (default 50.000 / 80.000)
//   SRL       → BOB  (default 49.999 / 300.000)
//
// Base legal SRL: RND 102400000021 (Bancarización Bolivia, vigente ene 2025).
// El umbral de Bs 50.000 activa la obligatoriedad de documento bancario (IVA/IUE).
// El límite de Bs 49.999 se mantiene por debajo para operar sin esa exigencia
// mientras AV Finance SRL completa su licencia ETF/PSAV ante ASFI.

const transactionLimitsSchema = new Schema(
  {
    /** Monto máximo por operación individual (en `currency`) */
    maxSingleTransaction: { type: Number, default: 50_000 },
    /** Volumen máximo mensual acumulado (en `currency`) */
    maxMonthlyVolume:     { type: Number, default: 80_000 },
    /** Moneda en que se expresan los límites (ISO 4217) */
    currency:             { type: String, default: 'USD' },
    /**
     * Nota legal visible al usuario en la interfaz.
     * Para SRL/BOB: explica la restricción regulatoria de bancarización.
     */
    regulatoryNote:       { type: String, default: null },
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
        'SRL',   // Sociedad de Responsabilidad Limitada
        'SA',    // Sociedad Anónima
        'SpA',   // Sociedad por Acciones
        'LLC',   // Limited Liability Company
        'LLP',   // Limited Liability Partnership
        'IND',   // Empresa Individual
        'OTHER', // Otro
        // Legacy values (pre-Phase 35)
        'sole_proprietor', 'llc', 'corporation', 'partnership', 'ngo',
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
        '0-10k',     // Menos de $10.000 USD
        '10k-50k',   // $10.000 – $50.000 USD
        '50k-100k',  // $50.000 – $100.000 USD
        '100k-500k', // $100.000 – $500.000 USD
        '500k+',     // Más de $500.000 USD
        // Legacy values
        'under_5k', '5k_20k', '20k_60k', 'over_60k',
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

// Nota: businessId y userId tienen `unique: true` en el campo, lo que ya crea
// índices implícitos. No los redeclaramos aquí para evitar el warning de Mongoose
// "Duplicate schema index".
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
