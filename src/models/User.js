/**
 * User.js — Modelo de Usuario con KYC Multi-Entidad
 *
 * El campo `legalEntity` es el eje central de la arquitectura multi-jurisdicción:
 * determina bajo qué entidad AV Finance opera el usuario y qué reglas de
 * compliance, límites KYC y proveedores aplican en cada transacción.
 *
 *   LLC → AV Finance LLC (Delaware)  — usuarios corporativos / EE.UU.
 *   SpA → AV Finance SpA (Chile)     — usuarios con origen CL
 *   SRL → AV Finance SRL (Bolivia)   — usuarios con destino BO
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

// ─── Sub-esquema: Documento de Identidad ────────────────────────────────────

const identityDocumentSchema = new Schema(
  {
    /** Tipo de documento según jurisdicción */
    type: {
      type:     String,
      enum:     ['passport', 'national_id', 'rut', 'ci_bolivia', 'nit', 'ein'],
      required: true,
    },
    /** Número de documento — cifrado en reposo en producción (AWS KMS) */
    number: {
      type:     String,
      required: true,
      trim:     true,
    },
    /** País emisor del documento (ISO 3166-1 alpha-2) */
    issuingCountry: {
      type:      String,
      required:  true,
      uppercase: true,
      trim:      true,
      minlength: 2,
      maxlength: 2,
    },
    /** Fecha de vencimiento (null si no aplica) */
    expiresAt: {
      type:    Date,
      default: null,
    },
  },
  { _id: false },
);

// ─── Sub-esquema: Dirección ──────────────────────────────────────────────────

const addressSchema = new Schema(
  {
    street:  { type: String, trim: true },
    city:    { type: String, trim: true },
    state:   { type: String, trim: true },
    zip:     { type: String, trim: true },
    /** ISO 3166-1 alpha-2 */
    country: { type: String, uppercase: true, trim: true, minlength: 2, maxlength: 2 },
  },
  { _id: false },
);

// ─── Sub-esquema: Cuenta Stellar ─────────────────────────────────────────────

const stellarAccountSchema = new Schema(
  {
    /** Stellar public key del usuario (G...) — segura para almacenar y loguear */
    publicKey: {
      type:   String,
      trim:   true,
      match:  /^G[A-Z2-7]{55}$/,
    },
    /** Indica si la cuenta fue creada y fondeada por Alyto */
    createdByAlyto: { type: Boolean, default: false },
    /** Assets con trustline activa en esta cuenta */
    activeTrustlines: {
      type:    [String],
      default: [],
    },
  },
  { _id: false },
);

// ─── Esquema Principal: User ─────────────────────────────────────────────────

const userSchema = new Schema(
  {
    // ── Datos básicos ───────────────────────────────────────────────────────
    firstName: {
      type:     String,
      required: true,
      trim:     true,
    },
    lastName: {
      type:     String,
      required: true,
      trim:     true,
    },
    email: {
      type:      String,
      required:  true,
      unique:    true,
      lowercase: true,
      trim:      true,
      match:     /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    phone: {
      type:  String,
      trim:  true,
    },
    /** Foto de perfil como data URL base64 (max ~150 KB tras compresión en cliente) */
    avatarUrl: {
      type:    String,
      default: null,
    },

    // ── Campo CRÍTICO: Jurisdicción Multi-Entidad ────────────────────────────
    /**
     * Entidad legal AV Finance bajo la que opera este usuario.
     * Determina: proveedores disponibles, límites KYC/KYB, reglas de compliance
     * y el corredor de pago que el transactionRouter seleccionará.
     *
     *   'LLC' → AV Finance LLC (Delaware)  — corporativos / origen EE.UU.
     *   'SpA' → AV Finance SpA (Chile)     — usuarios con origen CL
     *   'SRL' → AV Finance SRL (Bolivia)   — usuarios con destino BO
     */
    legalEntity: {
      type:     String,
      enum:     ['LLC', 'SpA', 'SRL'],
      required: true,
    },

    // ── Tipo de cliente ─────────────────────────────────────────────────────
    clientType: {
      type:    String,
      enum:    ['personal', 'corporate'],
      default: 'personal',
    },

    // ── KYC / KYB ───────────────────────────────────────────────────────────
    identityDocument: {
      type:     identityDocumentSchema,
      required: true,
    },
    address: {
      type: addressSchema,
    },
    /** ISO 3166-1 alpha-2 — país de residencia fiscal */
    residenceCountry: {
      type:      String,
      uppercase: true,
      trim:      true,
      minlength: 2,
      maxlength: 2,
    },
    /** Fecha de nacimiento (requerida para KYC personal) */
    dateOfBirth: {
      type: Date,
    },

    // ── Estado KYC ──────────────────────────────────────────────────────────
    kycStatus: {
      type:    String,
      enum:    ['pending', 'in_review', 'approved', 'rejected', 'expired'],
      default: 'pending',
    },
    kycApprovedAt: {
      type:    Date,
      default: null,
    },
    /** Proveedor que realizó la verificación KYC (ej. 'stripe_identity', 'manual') */
    kycProvider: {
      type:    String,
      default: null,
    },
    /**
     * ID de la VerificationSession de Stripe Identity.
     * Se usa como clave de lookup en el webhook para actualizar kycStatus.
     * Ej: 'vs_1ABC...'
     */
    stripeVerificationSessionId: {
      type:    String,
      default: null,
    },

    // ── Cuenta Stellar ──────────────────────────────────────────────────────
    stellarAccount: {
      type: stellarAccountSchema,
    },

    // ── Cuenta corporativa (solo si clientType = 'corporate') ───────────────
    companyName: {
      type:  String,
      trim:  true,
    },
    taxId: {
      type:  String,
      trim:  true,
    },

    // ── Credenciales de acceso ───────────────────────────────────────────────
    /**
     * Hash bcrypt de la contraseña. select:false evita que se incluya
     * accidentalmente en queries. Leer con .select('+password') solo en auth.
     */
    password: {
      type:   String,
      select: false,
    },

    // ── Documentos KYC (referencias a archivos) ──────────────────────────────
    /**
     * Array de referencias a documentos de identidad subidos (RUT, NIT, EIN, etc.).
     * Cada entrada apunta a un archivo en el storage (S3 / local).
     */
    kycDocuments: {
      type: [
        {
          /** Tipo de documento: rut, nit, ein, ci_bolivia, passport, etc. */
          docType:    { type: String, required: true },
          /** Referencia al archivo (S3 key, URL firmada, o path local) */
          fileRef:    { type: String, required: true },
          uploadedAt: { type: Date, default: Date.now },
          _id: false,
        },
      ],
      default: [],
    },

    // ── Registro de aceptación de Términos de Servicio ──────────────────────
    /**
     * Almacena el registro de la aceptación del ToS para auditoría AML/CFT.
     * Incluye IP y user-agent del momento de aceptación.
     */
    tosAcceptance: {
      type: {
        accepted:   { type: Boolean, default: false },
        version:    { type: String },
        entity:     { type: String, enum: ['LLC', 'SpA', 'SRL'] },
        acceptedAt: { type: Date },
        ipAddress:  { type: String },
        userAgent:  { type: String },
        _id: false,
      },
      default: null,
    },

    // ── Tipo de cuenta y KYB ────────────────────────────────────────────────
    /**
     * Tipo de cuenta del usuario.
     *   'personal' → Wallet personal (solo KYC)
     *   'business' → Cuenta Business con KYB aprobado — accede a corredores
     *                institucionales (OwlPay, tickets altos)
     */
    accountType: {
      type:    String,
      enum:    ['personal', 'business'],
      default: 'personal',
    },
    /**
     * Estado del proceso KYB (Know Your Business).
     * Solo relevante cuando el usuario solicita activar su cuenta Business.
     * Sincronizado con BusinessProfile.kybStatus.
     */
    kybStatus: {
      type:    String,
      enum:    ['not_started', 'pending', 'under_review', 'approved', 'rejected', 'more_info'],
      default: 'not_started',
    },
    /** Referencia al perfil KYB — solo existe si accountType === 'business' */
    businessProfileId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'BusinessProfile',
      default: null,
    },

    // ── Rol de la cuenta ────────────────────────────────────────────────────
    /**
     * Rol del usuario dentro del sistema Alyto.
     *   'user'  → Cliente estándar (acceso al wallet y operaciones propias)
     *   'admin' → Operador interno (acceso al backoffice de auditoría)
     */
    role: {
      type:    String,
      enum:    ['user', 'admin'],
      default: 'user',
    },

    // ── Estado y seguridad ──────────────────────────────────────────────────
    isActive: {
      type:    Boolean,
      default: true,
    },
    lastLoginAt: {
      type: Date,
    },

    // ── Reset de contraseña ──────────────────────────────────────────────────
    /** Hash SHA-256 del token enviado por email. Se almacena el hash, nunca el texto claro. */
    passwordResetToken: {
      type:   String,
      select: false,
    },
    /** Fecha de expiración del token de reset (1 hora desde la generación). */
    passwordResetExpires: {
      type:   Date,
      select: false,
    },

    // ── Preferencias del usuario ─────────────────────────────────────────────
    preferences: {
      type: {
        language: { type: String, default: 'es' },
        currency: { type: String, default: 'CLP' },
        notifications: {
          type: {
            email: { type: Boolean, default: true },
            push:  { type: Boolean, default: true },
          },
          default: () => ({}),
          _id: false,
        },
      },
      default: () => ({}),
      _id: false,
    },

    // ── Notificaciones Push (FCM) ────────────────────────────────────────────
    /**
     * Tokens FCM de los dispositivos del usuario.
     * Un usuario puede tener múltiples dispositivos (iOS, Android, web).
     * Los tokens expirados se eliminan automáticamente en notifications.js.
     * Máximo 5 tokens por usuario (el más antiguo se descarta en el endpoint).
     */
    fcmTokens: {
      type:    [String],
      default: [],
    },
  },
  {
    timestamps: true, // createdAt, updatedAt automáticos
    collection: 'users',
  },
);

// ─── Índices ─────────────────────────────────────────────────────────────────

userSchema.index({ legalEntity: 1 });
userSchema.index({ kycStatus: 1 });
userSchema.index({ kybStatus: 1 });
userSchema.index({ accountType: 1 });
userSchema.index({ 'stellarAccount.publicKey': 1 }, { sparse: true });

// ─── Virtual: nombre completo ─────────────────────────────────────────────────

userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

const User = mongoose.model('User', userSchema);

export default User;
