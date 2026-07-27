// src/models/WaitlistEntry.js
//
// Lista de espera del lanzamiento de alyto.io (31-ago-2026).
//
// Captura los registros de la landing estática. NO es una colección financiera:
// no toca saldos ni transacciones, y vive aparte del ledger a propósito.
//
// `tipo` distingue persona de empresa porque el público prioritario del
// lanzamiento son empresas bolivianas que pagan a proveedores en el exterior —
// un lead B2B y un usuario retail valen distinto y se trabajan distinto.
//
// `source` guarda la atribución (UTM + referrer) para saber qué canal trae
// registros. Sin esto no se puede decidir dónde invertir la pauta.
//
// Privacidad: se guarda el mínimo indispensable (correo + tipo + atribución).
// No se registra IP ni huella del navegador. `consent` deja constancia de que
// la persona aceptó recibir el aviso de lanzamiento; `unsubscribedAt` marca la
// baja sin borrar el registro (trazabilidad de la baja).

import mongoose from 'mongoose';

const waitlistEntrySchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,      // crea el índice — no declarar index:true aparte
    lowercase: true,
    trim: true,
    maxlength: 254,    // límite práctico de longitud de correo
  },

  // Segmentación del lanzamiento.
  tipo: {
    type: String,
    enum: ['persona', 'empresa'],
    default: 'persona',
    index: true,
  },

  // Solo cuando tipo === 'empresa'. Opcional: no bloquea el registro.
  empresa: { type: String, trim: true, maxlength: 120 },

  // Atribución de origen — de dónde vino este registro.
  source: {
    utmSource:   { type: String, trim: true, maxlength: 100 },
    utmMedium:   { type: String, trim: true, maxlength: 100 },
    utmCampaign: { type: String, trim: true, maxlength: 100 },
    utmContent:  { type: String, trim: true, maxlength: 100 },
    referrer:    { type: String, trim: true, maxlength: 300 },
    landing:     { type: String, trim: true, maxlength: 300 },
  },

  // Constancia de consentimiento para recibir el aviso de lanzamiento.
  consent: { type: Boolean, default: true },

  // Momento en que se le envió el aviso de lanzamiento (null = pendiente).
  notifiedAt:     { type: Date, default: null },
  // Baja de suscripción — se conserva el registro para trazabilidad.
  unsubscribedAt: { type: Date, default: null },
}, { timestamps: true });

// Consulta típica del lanzamiento: "empresas que aún no fueron avisadas".
waitlistEntrySchema.index({ tipo: 1, notifiedAt: 1 });

export default mongoose.model('WaitlistEntry', waitlistEntrySchema);
