import Contact from '../models/Contact.js'
import * as Sentry from '@sentry/node'

// GET /api/v1/contacts
export async function listContacts(req, res) {
  try {
    const { country } = req.query
    const filter = { userId: req.user._id }
    if (country) filter.destinationCountry = country

    const contacts = await Contact.find(filter)
      .sort({ isFavorite: -1, lastSentAt: -1, createdAt: -1 })
      .lean()

    return res.status(200).json({ contacts })
  } catch (err) {
    Sentry.captureException(err)
    return res.status(500).json({ error: 'Error al obtener contactos.' })
  }
}

// POST /api/v1/contacts
export async function createContact(req, res) {
  try {
    const {
      nickname, firstName, lastName,
      destinationCountry, destinationCurrency,
      formType, beneficiaryData,
      qrImageBase64, qrImageMimetype,
    } = req.body

    if (!destinationCountry || !formType || !beneficiaryData) {
      return res.status(400).json({
        error: 'destinationCountry, formType y beneficiaryData son requeridos.',
      })
    }

    // Evitar duplicados por número de cuenta
    if (beneficiaryData.beneficiary_account_number) {
      const existing = await Contact.findOne({
        userId: req.user._id,
        destinationCountry,
        formType,
        'beneficiaryData.beneficiary_account_number': beneficiaryData.beneficiary_account_number,
      })
      if (existing) {
        return res.status(409).json({
          error:     'Ya tienes un contacto con estos datos bancarios.',
          contactId: existing._id,
        })
      }
    }

    const contact = await Contact.create({
      userId: req.user._id,
      nickname:           nickname || '',
      firstName:          firstName || beneficiaryData.beneficiary_first_name || '',
      lastName:           lastName  || beneficiaryData.beneficiary_last_name  || '',
      destinationCountry,
      destinationCurrency,
      formType,
      beneficiaryData,
      qrImageBase64:   qrImageBase64   || null,
      qrImageMimetype: qrImageMimetype || null,
    })

    return res.status(201).json({ contact })
  } catch (err) {
    Sentry.captureException(err)
    return res.status(500).json({ error: 'Error al crear contacto.' })
  }
}

// PUT /api/v1/contacts/:contactId
export async function updateContact(req, res) {
  try {
    const { contactId } = req.params
    const contact = await Contact.findOne({ _id: contactId, userId: req.user._id })
    if (!contact) return res.status(404).json({ error: 'Contacto no encontrado.' })

    const allowed = ['nickname', 'firstName', 'lastName', 'beneficiaryData', 'qrImageBase64', 'qrImageMimetype']
    allowed.forEach(k => {
      if (req.body[k] !== undefined) contact[k] = req.body[k]
    })

    await contact.save()
    return res.status(200).json({ contact })
  } catch (err) {
    Sentry.captureException(err)
    return res.status(500).json({ error: 'Error al actualizar contacto.' })
  }
}

// DELETE /api/v1/contacts/:contactId
export async function deleteContact(req, res) {
  try {
    const { contactId } = req.params
    const deleted = await Contact.findOneAndDelete({ _id: contactId, userId: req.user._id })
    if (!deleted) return res.status(404).json({ error: 'Contacto no encontrado.' })
    return res.status(200).json({ deleted: true })
  } catch (err) {
    Sentry.captureException(err)
    return res.status(500).json({ error: 'Error al eliminar contacto.' })
  }
}

// PATCH /api/v1/contacts/:contactId/favorite
export async function toggleFavorite(req, res) {
  try {
    const { contactId } = req.params
    const contact = await Contact.findOne({ _id: contactId, userId: req.user._id })
    if (!contact) return res.status(404).json({ error: 'Contacto no encontrado.' })
    contact.isFavorite = !contact.isFavorite
    await contact.save()
    return res.status(200).json({ isFavorite: contact.isFavorite })
  } catch (err) {
    Sentry.captureException(err)
    return res.status(500).json({ error: 'Error al actualizar favorito.' })
  }
}

// Actualizar historial de envíos — fire-and-forget desde ipnController
export async function recordSent(contactId, amount, currency) {
  try {
    await Contact.findByIdAndUpdate(contactId, {
      $inc: { sendCount: 1, totalSent: amount },
      $set: { lastSentAt: new Date(), lastAmount: amount, lastCurrency: currency },
    })
  } catch (err) {
    console.error('[Contacts] Error en recordSent:', err.message)
  }
}
