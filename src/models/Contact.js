import mongoose from 'mongoose'

const contactSchema = new mongoose.Schema({
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },

  // Identificación del contacto
  nickname:  { type: String, default: '' },   // "Mamá", "Pedro trabajo"
  firstName: { type: String, default: '' },
  lastName:  { type: String, default: '' },

  // País y corredor
  destinationCountry:  { type: String, required: true },
  destinationCurrency: { type: String, default: '' },

  // Tipo de formulario del beneficiario
  formType: {
    type:     String,
    enum:     ['vita', 'bank_data', 'qr_image', 'owlpay'],
    required: true,
  },

  // Datos del beneficiario — misma estructura que beneficiaryData en la transacción
  beneficiaryData: {
    type:    mongoose.Schema.Types.Mixed,
    default: {},
  },

  // QR imagen (solo para formType: 'qr_image')
  qrImageBase64:   { type: String, default: null },
  qrImageMimetype: { type: String, default: null },

  // Historial de envíos a este contacto
  sendCount:    { type: Number, default: 0 },
  totalSent:    { type: Number, default: 0 },
  lastSentAt:   { type: Date,   default: null },
  lastAmount:   { type: Number, default: null },
  lastCurrency: { type: String, default: null },

  isFavorite: { type: Boolean, default: false },
}, { timestamps: true })

contactSchema.index({ userId: 1, destinationCountry: 1 })
contactSchema.index({ userId: 1, isFavorite: -1, lastSentAt: -1 })

export default mongoose.model('Contact', contactSchema)
