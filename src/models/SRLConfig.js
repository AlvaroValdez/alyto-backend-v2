/**
 * SRLConfig.js — Configuración operativa de AV Finance SRL (Bolivia)
 *
 * Singleton: existe un único documento con key = 'srl_bolivia'.
 * Se crea automáticamente al primer upsert desde el admin.
 *
 * Almacena los códigos QR de pago que el admin sube desde el backoffice.
 * Cada QR corresponde a una billetera/banco boliviano diferente:
 *   - Tigo Money       → QR de la app Tigo
 *   - Banco Bisa       → QR institucional del banco
 *   - SimpliCity       → QR Multicash/SimpliCity
 *   - QR P2P Bolivia   → QR genérico interoperable
 *
 * Los QR activos se incluyen automáticamente en las instrucciones de pago
 * de todos los corredores SRL (payinMethod === 'manual').
 *
 * Uso (lectura):
 *   const config = await SRLConfig.getActive();
 *   // → { qrImages: [{ label, imageBase64, isActive }] }
 */

import mongoose from 'mongoose';
import crypto   from 'crypto';

const { Schema } = mongoose;

// ─── Sub-esquema: Imagen QR ───────────────────────────────────────────────────

const qrImageSchema = new Schema(
  {
    /** ID único del QR — para operaciones de activar/desactivar/eliminar */
    qrId: {
      type:    String,
      default: () => crypto.randomBytes(4).toString('hex'),
    },
    /** Etiqueta visible al usuario — ej. "Tigo Money", "Banco Bisa QR" */
    label: {
      type:     String,
      required: true,
      trim:     true,
    },
    /** Imagen en base64 (data URL completa: "data:image/png;base64,...") */
    imageBase64: {
      type:     String,
      required: true,
    },
    /** Activo = visible al usuario en las instrucciones de pago */
    isActive: {
      type:    Boolean,
      default: true,
    },
    uploadedAt: {
      type:    Date,
      default: Date.now,
    },
    /** Admin que subió el QR */
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref:  'User',
    },
  },
  { _id: false },
);

// ─── Esquema Principal: SRLConfig ─────────────────────────────────────────────

const srlConfigSchema = new Schema(
  {
    /** Clave singleton — siempre 'srl_bolivia' */
    key: {
      type:    String,
      default: 'srl_bolivia',
      unique:  true,
    },
    /** Array de imágenes QR configuradas por el admin */
    qrImages: {
      type:    [qrImageSchema],
      default: [],
    },
    /** Datos bancarios de AV Finance SRL — se usan en las instrucciones de pago */
    bankData: {
      bankName:      { type: String, default: '' },
      accountHolder: { type: String, default: '' },
      accountNumber: { type: String, default: '' },
      accountType:   { type: String, default: '' },
    },
  },
  {
    timestamps: true,
    collection: 'srl_config',
  },
);

// ─── Método estático: obtener QR activos ──────────────────────────────────────

/**
 * Retorna el documento SRLConfig, creándolo si no existe.
 * Solo incluye los QR con isActive: true.
 *
 * @returns {Promise<{ qrImages: object[] }>}
 */
srlConfigSchema.statics.getActive = async function () {
  const doc = await this.findOneAndUpdate(
    { key: 'srl_bolivia' },
    { $setOnInsert: { key: 'srl_bolivia' } },
    { upsert: true, new: true },
  ).lean();

  return {
    ...doc,
    qrImages: (doc.qrImages ?? []).filter(q => q.isActive),
  };
};

const SRLConfig = mongoose.model('SRLConfig', srlConfigSchema);

export default SRLConfig;
