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
    /**
     * Número de documento.
     * - Si el cifrado PII está activo (PII_ENCRYPTION_ENABLED) y hay un CI real,
     *   este campo guarda el marcador `ENCRYPTED` y el valor real vive cifrado en
     *   `numberCiphertext`. Si no, guarda el sentinel `PENDING_VERIFICATION` o
     *   (modo legacy / flag OFF) el número en claro.
     * - Leer SIEMPRE vía `readDocumentNumber()` (utils/clientDocument.js), nunca
     *   este campo directo. Escribir vía `resolveDocumentNumberStorage()`.
     */
    number: {
      type:     String,
      required: true,
      trim:     true,
    },
    /**
     * Ciphertext AES-256-GCM del CI real (esquema `v1:` de services/piiCrypto.js),
     * sobre una DEK envuelta por AWS KMS. select:false — nunca sale en queries por
     * defecto ni en respuestas API; solo `readDocumentNumber()` lo descifra.
     */
    numberCiphertext: {
      type:   String,
      select: false,
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

// ─── Sub-esquema: Cuenta Stellar (modelo custodial) ──────────────────────────
// Alyto custodia los Activos Virtuales de los usuarios (PSAV — DS 5384, Cap. XI,
// Art. 4° literal l inciso 4). El keypair se genera en `custodyService.js` al
// aprobar el KYC. La secretKey se cifra en AWS KMS y se guarda como ciphertext;
// NUNCA se almacena en texto plano en MongoDB ni se loguea.

const stellarAccountSchema = new Schema(
  {
    /** Stellar public key del usuario (G...) — asignada al provisionar custodia */
    publicKey: {
      type:   String,
      trim:   true,
      match:  /^G[A-Z2-7]{55}$/,
    },
    /** Ciphertext KMS de la secretKey (base64). NUNCA en texto plano. */
    secretKeyCiphertext: {
      type:   String,
      select: false,   // no incluir en queries por defecto
    },
    /** Indica si la cuenta fue creada y fondeada por Alyto (modelo custodial) */
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
    /** Alias público Alyto para transferencias P2P (ej. "juan"). Único, minúsculas. */
    alytoAlias: {
      type:      String,
      default:   null,
      lowercase: true,
      trim:      true,
    },
    /** Última modificación del alias (para cooldown de cambios). */
    aliasUpdatedAt: {
      type:    Date,
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

    // ── Cumplimiento KYC (CDD/AML — requerido para reuso de KYC con Harbor/anchors) ──
    /** Nacionalidad declarada (ISO 3166-1 alpha-2) — distinta de residenceCountry. */
    nationality: {
      type:      String,
      uppercase: true,
      trim:      true,
      minlength: 2,
      maxlength: 2,
      default:   null,
    },
    /**
     * Origen de fondos declarado por el usuario (elemento CDD que exigen ASFI y
     * Harbor). Enum cerrado para normalizar el reporte de compliance.
     */
    sourceOfFunds: {
      type: String,
      enum: [
        'salary_employment', 'business_income', 'investments', 'savings',
        'inheritance_gift', 'property_sale', 'loan', 'other',
      ],
      default: null,
    },
    /** Momento en que el usuario completó el formulario de cumplimiento KYC. */
    kycProfileCompletedAt: {
      type:    Date,
      default: null,
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

    // ── Verificación de email ────────────────────────────────────────────────
    /** True una vez que el usuario confirma su email con el código de 6 dígitos. */
    emailVerified: {
      type:    Boolean,
      default: false,
    },
    /** Hash SHA-256 del código de verificación vigente (nunca en texto plano). */
    emailVerificationCode: {
      type:   String,
      select: false,
    },
    /** Expiración del código de verificación. */
    emailVerificationExpires: {
      type:   Date,
      select: false,
    },
    /** Intentos fallidos del código vigente (bloqueo anti-brute-force). */
    emailVerificationAttempts: {
      type:    Number,
      default: 0,
      select:  false,
    },
    /** Último envío de código (cooldown de reenvío). */
    emailVerificationLastSent: {
      type:   Date,
      select: false,
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
    /**
     * Fallos de autenticación consecutivos. Se reinicia en cada acceso exitoso.
     * El historial completo vive en AccessLog; este contador existe sólo para
     * decidir el bloqueo sin agregar la colección en cada intento.
     */
    failedLoginAttempts: {
      type:    Number,
      default: 0,
    },
    /**
     * Bloqueo temporal por intentos fallidos (Art. 2° inc. d, Sec. 4 del
     * Reglamento ETF). Null o fecha pasada significa cuenta habilitada.
     */
    lockedUntil: {
      type:    Date,
      default: null,
    },
    /**
     * Contador monotónico para revocación de JWTs.
     * Se incrementa en logout, password reset, o suspensión admin.
     * El middleware protect() compara decoded.tokenVersion !== user.tokenVersion
     * para rechazar tokens emitidos antes del último bump.
     */
    tokenVersion: {
      type:     Number,
      default:  0,
      required: true,
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
        currency: { type: String, default: 'USD' },
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

    // ── AML / Sanciones (Fase 28 — ASFI Bolivia) ─────────────────────────────
    /**
     * Indica si el último screening encontró un posible hit en listas de
     * sanciones (OFAC, ONU, UIF Bolivia, PEPs).
     * true = requiere revisión manual del Oficial de Cumplimiento.
     * La transacción se bloquea vía checkSanctions middleware — este flag
     * sirve para visibilidad en el backoffice admin.
     */
    sanctionsFlag: {
      type:    Boolean,
      default: false,
    },
    sanctionsScreenedAt: {
      type:    Date,
      default: null,
    },

    // ── Eliminación de cuenta (requisito Google Play + GDPR / Ley 19.628) ──────
    /**
     * Estado del ciclo de eliminación de cuenta solicitada por el usuario.
     *
     *   'active'              → cuenta normal
     *   'deletion_requested'  → el usuario solicitó la baja; la cuenta queda
     *                            desactivada (isActive=false) y los datos PII no
     *                            regulatorios se anonimizan de inmediato, PERO los
     *                            registros KYC/transaccionales se RETIENEN durante
     *                            el plazo legal (ASFI/UIF) antes de purgarse.
     *   'anonymized'          → purga final de PII tras cumplir la retención legal.
     *
     * ⚠️ NO es un hard-delete. El modelo PSAV custodial (DS 5384, Cap. XI) y la
     * normativa AML/CFT exigen conservar la traza de cumplimiento. Google Play
     * admite la retención de datos exigidos por ley siempre que se divulgue.
     */
    deletionStatus: {
      type:    String,
      enum:    ['active', 'deletion_requested', 'anonymized'],
      default: 'active',
    },
    /** Momento en que el usuario solicitó la eliminación de la cuenta. */
    deletionRequestedAt: {
      type:    Date,
      default: null,
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
// Único PARCIAL solo sobre strings: permite múltiples null (usuarios sin alias)
// y mantiene unicidad de los alias asignados (case-insensitive vía lowercase).
userSchema.index(
  { alytoAlias: 1 },
  { unique: true, partialFilterExpression: { alytoAlias: { $type: 'string' } } },
);

// ─── Virtual: nombre completo ─────────────────────────────────────────────────

userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

const User = mongoose.model('User', userSchema);

export default User;
