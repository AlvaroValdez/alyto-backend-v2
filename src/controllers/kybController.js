/**
 * kybController.js — KYB Manual para cuentas Business
 *
 * Flujo completo:
 *   1. Usuario personal (kycStatus approved) envía solicitud KYB
 *   2. Admin revisa en /api/v1/admin/kyb
 *   3. Admin aprueba/rechaza/solicita más información
 *   4. Emails SendGrid en cada transición de estado
 *
 * Endpoints usuario:
 *   POST  /api/v1/kyb/apply      — Enviar solicitud KYB (multipart/form-data)
 *   GET   /api/v1/kyb/status     — Estado actual del KYB
 *   POST  /api/v1/kyb/documents  — Subir documentos adicionales (more_info)
 *
 * Endpoints admin (montados en adminRoutes.js bajo /api/v1/admin/kyb):
 *   GET   /api/v1/admin/kyb                      — Listar solicitudes KYB
 *   GET   /api/v1/admin/kyb/:businessId          — Detalle de solicitud
 *   PATCH /api/v1/admin/kyb/:businessId/review   — Aprobar / rechazar / more_info
 */

import Sentry         from '../services/sentry.js';
import { sendEmail, EMAILS } from '../services/email.js';
import { notifyAdmins, NOTIFICATIONS } from '../services/notifications.js';
import BusinessProfile from '../models/BusinessProfile.js';
import User            from '../models/User.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convierte el Buffer de multer a base64.
 * @param {import('multer').File} file
 * @returns {{ type, filename, data, mimetype, uploadedAt }}
 */
function fileToBase64(file) {
  return {
    type:       'other',
    filename:   file.originalname,
    data:       file.buffer.toString('base64'),
    mimetype:   file.mimetype,
    uploadedAt: new Date(),
  };
}

// ─── POST /api/v1/kyb/apply ──────────────────────────────────────────────────

/**
 * Enviar solicitud KYB.
 *
 * Requiere: JWT + KYC aprobado (kycStatus === 'approved').
 * Content-Type: multipart/form-data
 *
 * Campos:
 *   businessData  {string}  — JSON con datos de la empresa (ver BusinessProfile)
 *   documentos    {File[]}  — Archivos del expediente KYB (máx. 10, 10 MB cada uno)
 *
 * @returns {201} { businessId, kybStatus, message }
 */
export async function applyKYB(req, res) {
  try {
    const user = req.user;

    // ── Validar KYC personal previo ──────────────────────────────────────────
    if (user.kycStatus !== 'approved') {
      return res.status(403).json({
        error:    'KYC personal requerido.',
        message:  'Completa y aprueba tu verificación de identidad personal antes de solicitar una cuenta Business.',
        kycStatus: user.kycStatus,
      });
    }

    // ── Verificar que no existe solicitud previa ───────────────────────────────
    const existing = await BusinessProfile.findOne({ userId: user._id });
    if (existing) {
      return res.status(409).json({
        error:      'Solicitud KYB ya existe.',
        businessId: existing.businessId,
        kybStatus:  existing.kybStatus,
        message:    'Ya tienes una solicitud KYB registrada. Consulta su estado en GET /api/v1/kyb/status.',
      });
    }

    // ── Parsear businessData ──────────────────────────────────────────────────
    let businessData = {};
    try {
      businessData = JSON.parse(req.body.businessData ?? '{}');
    } catch {
      return res.status(400).json({
        error:   'businessData inválido.',
        message: 'El campo businessData debe ser un JSON válido.',
      });
    }

    // ── Convertir archivos a base64 ───────────────────────────────────────────
    const documents = (req.files ?? []).map((file, idx) => ({
      ...fileToBase64(file),
      // Si el frontend envía el tipo en el nombre del campo, usarlo; si no, 'other'
      type: businessData.documentTypes?.[idx] ?? 'other',
    }));

    // ── Límites operativos según entidad legal ───────────────────────────────
    // SRL/BOB: Bs 49.999 por transacción, Bs 300.000 mensual.
    // Base legal: RND 102400000021 (Bancarización Bolivia, ene 2025).
    // El umbral de Bs 50.000 activa exigencia de documento bancario ASFI.
    const initialLimits = user.legalEntity === 'SRL'
      ? {
          maxSingleTransaction: 49_999,
          maxMonthlyVolume:     300_000,
          currency:             'BOB',
          regulatoryNote:       'Límites establecidos conforme a la RND 102400000021 (Bancarización Bolivia). Las operaciones igual o superiores a Bs 50.000 requieren respaldo con documento bancario emitido por una entidad regulada por ASFI. Estos límites serán actualizados al obtener la licencia ETF/PSAV.',
        }
      : {
          maxSingleTransaction: 50_000,
          maxMonthlyVolume:     80_000,
          currency:             'USD',
          regulatoryNote:       null,
        };

    // ── Crear BusinessProfile ─────────────────────────────────────────────────
    const profile = await BusinessProfile.create({
      userId:                  user._id,
      legalName:               businessData.legalName,
      tradeName:               businessData.tradeName,
      taxId:                   businessData.taxId,
      countryOfIncorporation:  businessData.countryOfIncorporation,
      businessType:            businessData.businessType,
      industry:                businessData.industry,
      website:                 businessData.website,
      phone:                   businessData.phone,
      address:                 businessData.address,
      city:                    businessData.city,
      country:                 businessData.country,
      legalRepresentative:     businessData.legalRepresentative ?? null,
      estimatedMonthlyVolume:  businessData.estimatedMonthlyVolume,
      mainCorridors:           businessData.mainCorridors ?? [],
      businessDescription:     businessData.businessDescription,
      documents,
      kybStatus:               'pending',
      transactionLimits:       initialLimits,
    });

    // ── Actualizar User ───────────────────────────────────────────────────────
    // accountType permanece 'personal' hasta que admin apruebe el KYB.
    // El cambio a 'business' ocurre en reviewKyb cuando status === 'approved'.
    await User.findByIdAndUpdate(user._id, {
      kybStatus:         'pending',
      businessProfileId: profile._id,
    });

    console.info('[KYB] Solicitud creada.', {
      userId:     user._id,
      businessId: profile.businessId,
      empresa:    profile.legalName,
      país:       profile.countryOfIncorporation,
    });

    // ── Emails ────────────────────────────────────────────────────────────────
    // Al usuario: solicitud recibida
    sendEmail(...EMAILS.kybReceived(user, profile)).catch(() => {});

    // Al admin: push + in-app + email
    const fullName = `${user.firstName} ${user.lastName}`.trim();
    notifyAdmins(
      NOTIFICATIONS.adminKybSubmitted(profile.legalName ?? profile.tradeName ?? 'empresa', fullName),
      { email: EMAILS.adminKybAlert(user, profile) },
    ).catch(() => {});

    return res.status(201).json({
      businessId: profile.businessId,
      kybStatus:  profile.kybStatus,
      message:    'Solicitud Business recibida. Revisaremos tu expediente y te notificaremos por email.',
    });

  } catch (err) {
    console.error('[KYB] Error en applyKYB:', err.message, err.errors ?? '');
    Sentry.captureException(err, { tags: { controller: 'kybController', action: 'applyKYB' } });
    return res.status(500).json({
      error: 'Error interno al procesar la solicitud KYB.',
      ...(process.env.NODE_ENV !== 'production' ? { detail: err.message, validationErrors: err.errors } : {}),
    });
  }
}

// ─── GET /api/v1/kyb/status ──────────────────────────────────────────────────

/**
 * Devuelve el estado actual del KYB del usuario autenticado.
 *
 * @returns {{ kybStatus, businessId, submittedAt, reviewedAt, kybNote, kybRejectionReason }}
 */
export async function getKYBStatus(req, res) {
  try {
    const user = req.user;

    if (!user.businessProfileId) {
      return res.status(200).json({
        kybStatus:        user.kybStatus ?? 'not_started',
        businessId:       null,
        submittedAt:      null,
        reviewedAt:       null,
        kybNote:          null,
        kybRejectionReason: null,
        missingDocuments: [],
      });
    }

    const profile = await BusinessProfile.findById(user.businessProfileId)
      .select('-documents.data')  // excluir base64 de la respuesta de estado
      .lean();

    if (!profile) {
      return res.status(200).json({ kybStatus: 'not_started' });
    }

    return res.status(200).json({
      kybStatus:          profile.kybStatus,
      businessId:         profile.businessId,
      submittedAt:        profile.createdAt,
      reviewedAt:         profile.kybReviewedAt,
      kybNote:            profile.kybNote,
      kybRejectionReason: profile.kybRejectionReason,
      missingDocuments:   [],  // el admin los especifica en kybNote o por email
      transactionLimits:  profile.kybStatus === 'approved' ? profile.transactionLimits : null,
    });

  } catch (err) {
    console.error('[KYB] Error en getKYBStatus:', err.message);
    Sentry.captureException(err, { tags: { controller: 'kybController', action: 'getKYBStatus' } });
    return res.status(500).json({ error: 'Error al consultar el estado KYB.' });
  }
}

// ─── POST /api/v1/kyb/documents ──────────────────────────────────────────────

/**
 * Subir documentos adicionales cuando el admin solicitó más información (more_info).
 *
 * Solo disponible si kybStatus === 'more_info'.
 *
 * @returns {{ documentsAdded, kybStatus }}
 */
export async function uploadKYBDocuments(req, res) {
  try {
    const user = req.user;

    const profile = await BusinessProfile.findById(user.businessProfileId);
    if (!profile) {
      return res.status(404).json({ error: 'Perfil Business no encontrado.' });
    }

    if (profile.kybStatus !== 'more_info') {
      return res.status(409).json({
        error:    'Documentos no esperados.',
        message:  `Solo puedes subir documentos adicionales cuando el estado es 'more_info'. Estado actual: '${profile.kybStatus}'.`,
        kybStatus: profile.kybStatus,
      });
    }

    if (!req.files?.length) {
      return res.status(400).json({ error: 'No se recibieron archivos.' });
    }

    let documentTypes = [];
    try {
      documentTypes = JSON.parse(req.body.documentTypes ?? '[]');
    } catch {
      documentTypes = [];
    }

    const newDocs = req.files.map((file, idx) => ({
      ...fileToBase64(file),
      type: documentTypes[idx] ?? 'other',
    }));

    profile.documents.push(...newDocs);
    // Reactivar la solicitud para revisión del admin
    profile.kybStatus = 'pending';
    await profile.save();

    // Sincronizar con User
    await User.findByIdAndUpdate(user._id, { kybStatus: 'pending' });

    // Alertar al admin que hay documentos nuevos — push + in-app + email
    const freshUser = await User.findById(user._id).lean();
    const kybFullName = `${freshUser.firstName} ${freshUser.lastName}`.trim();
    notifyAdmins(
      NOTIFICATIONS.adminKybSubmitted(profile.legalName ?? profile.tradeName ?? 'empresa', kybFullName),
      { email: EMAILS.adminKybAlert(freshUser, profile) },
    ).catch(() => {});

    console.info('[KYB] Documentos adicionales recibidos.', {
      userId:        user._id,
      businessId:    profile.businessId,
      docsAgregados: newDocs.length,
    });

    return res.status(200).json({
      documentsAdded: newDocs.length,
      kybStatus:      profile.kybStatus,
      message:        'Documentos recibidos. Tu solicitud está en revisión nuevamente.',
    });

  } catch (err) {
    console.error('[KYB] Error en uploadKYBDocuments:', err.message);
    Sentry.captureException(err, { tags: { controller: 'kybController', action: 'uploadKYBDocuments' } });
    return res.status(500).json({ error: 'Error al subir los documentos.' });
  }
}

// ─── Admin: GET /api/v1/admin/kyb ─────────────────────────────────────────────

/**
 * Listar solicitudes KYB con filtros y paginación.
 *
 * Query params:
 *   status                  — pending | under_review | approved | rejected | more_info
 *   country                 — ISO 3166-1 alpha-2 (countryOfIncorporation)
 *   estimatedMonthlyVolume  — under_5k | 5k_20k | 20k_60k | over_60k
 *   page                    — default 1
 *   limit                   — default 20, máx 100
 */
export async function listKYBApplications(req, res) {
  try {
    const {
      status, country, estimatedMonthlyVolume,
      page = 1, limit = 20,
    } = req.query;

    const filter = {};
    if (status)                 filter.kybStatus                = status;
    if (country)                filter.countryOfIncorporation   = country.toUpperCase();
    if (estimatedMonthlyVolume) filter.estimatedMonthlyVolume   = estimatedMonthlyVolume;

    const skip  = (Number(page) - 1) * Math.min(Number(limit), 100);
    const lim   = Math.min(Number(limit), 100);

    const [profiles, total] = await Promise.all([
      BusinessProfile.find(filter)
        .select('-documents.data')    // excluir base64 del listado
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(lim)
        .populate('userId', 'firstName lastName email kycStatus legalEntity')
        .lean(),
      BusinessProfile.countDocuments(filter),
    ]);

    return res.status(200).json({
      applications: profiles,
      pagination: {
        total,
        page:  Number(page),
        limit: lim,
        pages: Math.ceil(total / lim),
      },
    });

  } catch (err) {
    console.error('[KYB Admin] Error en listKYBApplications:', err.message);
    Sentry.captureException(err, { tags: { controller: 'kybController', action: 'listKYBApplications' } });
    return res.status(500).json({ error: 'Error al listar solicitudes KYB.' });
  }
}

// ─── Admin: GET /api/v1/admin/kyb/:businessId ─────────────────────────────────

/**
 * Detalle completo de una solicitud KYB incluyendo documentos en base64.
 */
export async function getKYBApplication(req, res) {
  try {
    const { businessId } = req.params;

    // Aceptar tanto businessId (BIZ-XXXXXXXX) como _id (ObjectId de 24 hex)
    const isObjectId = /^[a-f\d]{24}$/i.test(businessId);
    const filter = isObjectId ? { _id: businessId } : { businessId };

    const profile = await BusinessProfile.findOne(filter)
      .populate('userId', 'firstName lastName email kycStatus legalEntity residenceCountry')
      .populate('kybReviewedBy', 'firstName lastName email')
      .lean();

    if (!profile) {
      return res.status(404).json({ error: `Solicitud KYB "${businessId}" no encontrada.` });
    }

    // Incluir datos base64 de documentos en la vista de detalle admin
    const profileWithDocs = await BusinessProfile.findOne(filter)
      .select('+documents.data')
      .lean();

    return res.status(200).json({
      ...profile,
      documents: profileWithDocs?.documents ?? [],
    });

  } catch (err) {
    console.error('[KYB Admin] Error en getKYBApplication:', err.message);
    Sentry.captureException(err, { tags: { controller: 'kybController', action: 'getKYBApplication' } });
    return res.status(500).json({ error: 'Error al obtener la solicitud KYB.' });
  }
}

// ─── Admin: PATCH /api/v1/admin/kyb/:businessId/review ───────────────────────

/**
 * Aprobar, rechazar o solicitar más información en una solicitud KYB.
 *
 * Body:
 * {
 *   status:            'approved' | 'rejected' | 'more_info',
 *   note:              string,              // comentario visible al usuario
 *   rejectionReason:   string,              // solo si status === 'rejected'
 *   transactionLimits: { maxSingleTransaction, maxMonthlyVolume }  // solo si approved
 * }
 */
export async function reviewKYBApplication(req, res) {
  try {
    const { businessId }    = req.params;
    const { status, note, rejectionReason, transactionLimits } = req.body;
    const admin             = req.user;

    const validStatuses = ['approved', 'rejected', 'more_info', 'under_review'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error:   'Estado inválido.',
        message: `status debe ser uno de: ${validStatuses.join(', ')}`,
      });
    }

    // Aceptar tanto businessId (BIZ-XXXXXXXX) como _id (ObjectId de 24 hex)
    const isObjectId = /^[a-f\d]{24}$/i.test(businessId);
    const filter = isObjectId ? { _id: businessId } : { businessId };

    const profile = await BusinessProfile.findOne(filter);
    if (!profile) {
      return res.status(404).json({ error: `Solicitud KYB "${businessId}" no encontrada.` });
    }

    const user = await User.findById(profile.userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuario asociado no encontrado.' });
    }

    // ── Actualizar BusinessProfile ────────────────────────────────────────────
    profile.kybStatus       = status;
    profile.kybReviewedBy   = admin._id;
    profile.kybReviewedAt   = new Date();
    profile.kybNote         = note ?? null;
    profile.kybRejectionReason = status === 'rejected' ? (rejectionReason ?? null) : null;

    if (status === 'approved' && transactionLimits) {
      if (transactionLimits.maxSingleTransaction) {
        profile.transactionLimits.maxSingleTransaction = transactionLimits.maxSingleTransaction;
      }
      if (transactionLimits.maxMonthlyVolume) {
        profile.transactionLimits.maxMonthlyVolume = transactionLimits.maxMonthlyVolume;
      }
    }

    await profile.save();

    // ── Actualizar User ───────────────────────────────────────────────────────
    const userUpdate = { kybStatus: status };
    if (status === 'approved') {
      userUpdate.accountType = 'business';
    } else if (status === 'rejected') {
      userUpdate.accountType = 'personal';
    }
    await User.findByIdAndUpdate(profile.userId, userUpdate);

    console.info('[KYB Admin] Revisión registrada.', {
      businessId,
      status,
      adminId: admin._id,
      empresa: profile.legalName,
    });

    // ── Emails según decisión ─────────────────────────────────────────────────
    if (status === 'approved') {
      sendEmail(...EMAILS.kybApproved(user, profile)).catch(() => {});

    } else if (status === 'rejected') {
      sendEmail(...EMAILS.kybRejected(user, profile)).catch(() => {});

    } else if (status === 'more_info') {
      sendEmail(...EMAILS.kybMoreInfo(user, profile)).catch(() => {});
    }

    return res.status(200).json({
      businessId,
      kybStatus:    profile.kybStatus,
      kybReviewedAt: profile.kybReviewedAt,
      message:      `Solicitud KYB actualizada a "${status}".`,
    });

  } catch (err) {
    console.error('[KYB Admin] Error en reviewKYBApplication:', err.message);
    Sentry.captureException(err, { tags: { controller: 'kybController', action: 'reviewKYBApplication' } });
    return res.status(500).json({ error: 'Error al procesar la revisión KYB.' });
  }
}
