/**
 * userController.js — Gestión de Perfil y Cuenta de Usuario
 *
 * Endpoints:
 *   GET    /api/v1/user/profile         — Obtener perfil propio
 *   PATCH  /api/v1/user/profile         — Actualizar campos permitidos
 *   POST   /api/v1/user/change-password — Cambiar contraseña con verificación
 *   DELETE /api/v1/user/fcm-token       — Desvincular dispositivo (token FCM)
 *   GET    /api/v1/user/sessions        — Sesiones activas (info básica)
 *
 *   POST   /api/v1/user/kyc             — Verificación de identidad KYC
 */

import bcrypt from 'bcryptjs';
import User   from '../models/User.js';
import { ENTITY_CURRENCY_MAP } from '../utils/entityMaps.js';
import { invalidateUserCache } from '../middlewares/authMiddleware.js';
import { isRealDocumentNumber } from '../utils/clientDocument.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Regex para contraseña segura: ≥8 chars, 1 mayúscula, 1 número, 1 símbolo */
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

/** ISO 3166-1 alpha-2 (2 letras). */
const ISO2_RE = /^[A-Za-z]{2}$/;

/** Valores válidos de origen de fondos (espejo del enum del modelo User). */
const SOURCE_OF_FUNDS_VALUES = new Set([
  'salary_employment', 'business_income', 'investments', 'savings',
  'inheritance_gift', 'property_sale', 'loan', 'other',
]);

/** Campos que el usuario tiene permitido actualizar en su perfil */
const ALLOWED_UPDATE_FIELDS = new Set([
  'firstName',
  'lastName',
  'phone',
  'preferences.language',
  'preferences.currency',
  'preferences.notifications.email',
  'preferences.notifications.push',
]);

/**
 * Construye la respuesta pública del perfil a partir del documento User.
 * Nunca expone password, __v, ni arrays internos como fcmTokens.
 */
function buildProfileResponse(user) {
  return {
    id:             user._id,
    firstName:      user.firstName,
    lastName:       user.lastName,
    email:          user.email,
    phone:          user.phone   ?? null,
    country:        user.residenceCountry ?? null,
    entity:         user.legalEntity,
    kycStatus:      user.kycStatus,
    kycVerifiedAt:  user.kycApprovedAt ?? null,
    // ── Estado de onboarding / cumplimiento (consumido por el frontend) ──
    emailVerified:         user.emailVerified === true,
    kycProfileCompleted:   !!user.kycProfileCompletedAt,
    nationality:           user.nationality   ?? null,
    sourceOfFunds:         user.sourceOfFunds ?? null,
    dateOfBirth:           user.dateOfBirth   ?? null,
    address:               user.address ?? null,
    // CI/RUT declarado — null mientras siga el placeholder del registro.
    documentNumber:        isRealDocumentNumber(user.identityDocument?.number)
                             ? user.identityDocument.number : null,
    createdAt:      user.createdAt,
    avatarUrl:      user.avatarUrl ?? null,
    fcmTokens:      (user.fcmTokens ?? []).length,
    preferences: {
      language: user.preferences?.language  ?? 'es',
      currency: user.preferences?.currency  ?? ENTITY_CURRENCY_MAP[user.legalEntity] ?? 'USD',
      notifications: {
        email: user.preferences?.notifications?.email ?? true,
        push:  user.preferences?.notifications?.push  ?? true,
      },
    },
  };
}

// ─── GET /profile ─────────────────────────────────────────────────────────────

/**
 * getProfile
 * Devuelve el perfil del usuario autenticado.
 */
export async function getProfile(req, res) {
  try {
    const user = await User.findById(req.user._id).lean();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    return res.status(200).json(buildProfileResponse(user));
  } catch (err) {
    console.error('[UserCtrl] getProfile error:', err.message);
    return res.status(500).json({ error: 'Error interno al obtener el perfil.' });
  }
}

// ─── PATCH /profile ───────────────────────────────────────────────────────────

/**
 * updateProfile
 * Actualiza solo los campos permitidos. Rechaza cualquier intento de
 * modificar email, kycStatus, entity o role desde este endpoint.
 */
export async function updateProfile(req, res) {
  try {
    const body = req.body ?? {};

    // Construir $set solo con campos permitidos
    const $set = {};

    if (body.firstName !== undefined)  $set.firstName = String(body.firstName).trim();
    if (body.lastName  !== undefined)  $set.lastName  = String(body.lastName).trim();
    if (body.phone     !== undefined)  $set.phone     = String(body.phone).trim();

    if (body.preferences) {
      const prefs = body.preferences;
      if (prefs.language !== undefined)
        $set['preferences.language'] = String(prefs.language).trim();
      if (prefs.currency !== undefined)
        $set['preferences.currency'] = String(prefs.currency).trim();
      if (prefs.notifications) {
        if (prefs.notifications.email !== undefined)
          $set['preferences.notifications.email'] = Boolean(prefs.notifications.email);
        if (prefs.notifications.push !== undefined)
          $set['preferences.notifications.push'] = Boolean(prefs.notifications.push);
      }
    }

    // Verificar que no se intenten escribir campos protegidos
    const protectedFields = ['email', 'kycStatus', 'entity', 'legalEntity', 'role', 'password'];
    const attempted = protectedFields.filter(f => f in body);
    if (attempted.length > 0) {
      return res.status(400).json({
        error: `Los siguientes campos no pueden ser modificados por el usuario: ${attempted.join(', ')}.`,
      });
    }

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ error: 'No se enviaron campos válidos para actualizar.' });
    }

    const updated = await User.findByIdAndUpdate(
      req.user._id,
      { $set },
      { returnDocument: 'after', runValidators: true },
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Usuario no encontrado.' });

    return res.status(200).json(buildProfileResponse(updated));
  } catch (err) {
    console.error('[UserCtrl] updateProfile error:', err.message);
    return res.status(500).json({ error: 'Error interno al actualizar el perfil.' });
  }
}

// ─── PATCH /kyc-profile (información de cumplimiento) ──────────────────────────

/**
 * updateKycProfile — recolecta los elementos CDD/AML que Stripe Identity NO
 * provee y que Harbor/anchors requieren para reusar nuestro KYC:
 *   dateOfBirth, nationality, residential address, sourceOfFunds (+ phone).
 *
 * Se llama ANTES de lanzar Stripe Identity. Setea kycProfileCompletedAt, que
 * actúa como gate para crear la sesión biométrica.
 *
 * También captura el número de documento DECLARADO (CI/RUT/pasaporte). ASFI: el
 * Comprobante Oficial debe listar el documento del cliente, y Stripe Identity
 * no devuelve id_number de forma confiable para CI boliviano — la declaración
 * en el CDD es la fuente primaria. Gated: KYC_REQUIRE_DOCUMENT_NUMBER=true lo
 * vuelve obligatorio (mismo gate que usaba el flujo /identity/verify retirado).
 *
 * Body: { dateOfBirth, nationality, sourceOfFunds, address:{street,city,state,zip,country}, phone?, documentNumber? }
 */
export async function updateKycProfile(req, res) {
  try {
    const b = req.body ?? {};
    const errors = [];

    // — Fecha de nacimiento (mayor de 18) —
    let dob;
    if (b.dateOfBirth === undefined || b.dateOfBirth === null || b.dateOfBirth === '') {
      errors.push('La fecha de nacimiento es requerida.');
    } else {
      dob = new Date(b.dateOfBirth);
      if (Number.isNaN(dob.getTime())) {
        errors.push('Fecha de nacimiento inválida.');
      } else {
        const ageYears = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        if (ageYears < 18)  errors.push('Debes ser mayor de 18 años para usar Alyto.');
        if (ageYears > 120) errors.push('Fecha de nacimiento inválida.');
      }
    }

    // — Nacionalidad (ISO2) —
    const nationality = typeof b.nationality === 'string' ? b.nationality.trim().toUpperCase() : '';
    if (!ISO2_RE.test(nationality)) errors.push('Selecciona tu nacionalidad.');

    // — Origen de fondos —
    const sourceOfFunds = typeof b.sourceOfFunds === 'string' ? b.sourceOfFunds.trim() : '';
    if (!SOURCE_OF_FUNDS_VALUES.has(sourceOfFunds)) errors.push('Selecciona el origen de los fondos.');

    // — Domicilio —
    const a       = b.address ?? {};
    const street  = typeof a.street  === 'string' ? a.street.trim()  : '';
    const city    = typeof a.city    === 'string' ? a.city.trim()    : '';
    const state   = typeof a.state   === 'string' ? a.state.trim()    : '';
    const zip     = typeof a.zip     === 'string' ? a.zip.trim()      : '';
    const country = typeof a.country === 'string' ? a.country.trim().toUpperCase() : '';
    if (!street)              errors.push('La dirección (calle) es requerida.');
    if (!city)                errors.push('La ciudad es requerida.');
    if (!ISO2_RE.test(country)) errors.push('Selecciona el país de residencia.');

    // — Número de documento declarado (CI/RUT/pasaporte) —
    const documentNumber = typeof b.documentNumber === 'string' ? b.documentNumber.trim() : '';
    const requireDoc     = process.env.KYC_REQUIRE_DOCUMENT_NUMBER === 'true';
    if (documentNumber && (documentNumber.length < 4 || documentNumber.length > 30)) {
      errors.push('El número de documento debe tener entre 4 y 30 caracteres.');
    }
    if (requireDoc && !documentNumber) {
      errors.push('Ingresa tu número de documento (CI).');
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }

    // — Teléfono: requerido (Harbor). Puede venir aquí o ya estar en el perfil. —
    const phone   = typeof b.phone === 'string' ? b.phone.trim() : '';
    const current = await User.findById(req.user._id).select('phone').lean();
    if (!phone && !current?.phone) {
      return res.status(400).json({ error: 'El número de teléfono es requerido.' });
    }

    const $set = {
      dateOfBirth:           dob,
      nationality,
      sourceOfFunds,
      address:               { street, city, state, zip, country },
      kycProfileCompletedAt: new Date(),
    };
    if (phone) $set.phone = phone;
    // El CI declarado reemplaza el placeholder 'PENDING_VERIFICATION' del registro.
    if (documentNumber) $set['identityDocument.number'] = documentNumber;

    const updated = await User.findByIdAndUpdate(
      req.user._id,
      { $set },
      { returnDocument: 'after', runValidators: true },
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Usuario no encontrado.' });
    invalidateUserCache(req.user._id); // refrescar el gate kycProfileCompletedAt en protect()

    return res.status(200).json(buildProfileResponse(updated));
  } catch (err) {
    console.error('[UserCtrl] updateKycProfile error:', err.message);
    return res.status(500).json({ error: 'Error al guardar la información de cumplimiento.' });
  }
}

// ─── POST /change-password ────────────────────────────────────────────────────

/**
 * changePassword
 * Verifica la contraseña actual, valida los requisitos de la nueva y actualiza.
 */
export async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body ?? {};

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        error: 'Se requieren currentPassword, newPassword y confirmPassword.',
      });
    }

    // 1. Cargar usuario con hash de contraseña
    const user = await User.findById(req.user._id).select('+password');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    // 2. Verificar contraseña actual
    const isMatch = await bcrypt.compare(currentPassword, user.password ?? '');
    if (!isMatch) {
      return res.status(400).json({ error: 'La contraseña actual es incorrecta.' });
    }

    // 3. Verificar confirmación
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'La nueva contraseña y su confirmación no coinciden.' });
    }

    // 4. Verificar requisitos de seguridad
    if (!PASSWORD_REGEX.test(newPassword)) {
      return res.status(400).json({
        error: 'La nueva contraseña debe tener mínimo 8 caracteres, una mayúscula, un número y un símbolo.',
      });
    }

    // 5. Hashear y guardar
    const hashed = await bcrypt.hash(newPassword, 12);
    await User.findByIdAndUpdate(req.user._id, { $set: { password: hashed } });

    return res.status(200).json({ message: 'Contraseña actualizada.' });
  } catch (err) {
    console.error('[UserCtrl] changePassword error:', err.message);
    return res.status(500).json({ error: 'Error interno al cambiar la contraseña.' });
  }
}

// ─── DELETE /fcm-token ────────────────────────────────────────────────────────

/**
 * deleteFcmToken
 * Elimina un token FCM del array del usuario usando $pull de MongoDB.
 */
export async function deleteFcmToken(req, res) {
  try {
    const { token } = req.body ?? {};

    if (!token) {
      return res.status(400).json({ error: 'Se requiere el campo token.' });
    }

    await User.findByIdAndUpdate(
      req.user._id,
      { $pull: { fcmTokens: token } },
    );

    return res.status(200).json({ message: 'Dispositivo desvinculado.' });
  } catch (err) {
    console.error('[UserCtrl] deleteFcmToken error:', err.message);
    return res.status(500).json({ error: 'Error interno al desvincular el dispositivo.' });
  }
}

// ─── GET /sessions ────────────────────────────────────────────────────────────

/**
 * getSessions
 * Devuelve información básica de sesiones activas del usuario.
 * La sesión actual se infiere del request en curso.
 */
export async function getSessions(req, res) {
  try {
    const user = await User.findById(req.user._id).select('fcmTokens').lean();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    return res.status(200).json({
      sessions: [
        {
          deviceCount: (user.fcmTokens ?? []).length,
          currentSession: {
            ip:         req.ip,
            userAgent:  req.headers['user-agent'] ?? null,
            lastActive: new Date(),
          },
        },
      ],
    });
  } catch (err) {
    console.error('[UserCtrl] getSessions error:', err.message);
    return res.status(500).json({ error: 'Error interno al obtener las sesiones.' });
  }
}

// ─── PATCH /avatar ────────────────────────────────────────────────────────────

/**
 * uploadAvatar
 * Recibe la imagen vía multipart (field: 'avatar'), la convierte a data URL
 * base64 y la guarda en user.avatarUrl.
 * Tamaño máximo aceptado: 2 MB (el cliente debe redimensionar antes de enviar).
 */
export async function uploadAvatar(req, res) {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No se recibió ninguna imagen.' });
    }

    // Convertir buffer a data URL base64
    const mimeType  = file.mimetype;
    const base64    = file.buffer.toString('base64');
    const dataUrl   = `data:${mimeType};base64,${base64}`;

    const updated = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { avatarUrl: dataUrl } },
      { returnDocument: 'after' },
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Usuario no encontrado.' });

    return res.status(200).json({ avatarUrl: dataUrl });
  } catch (err) {
    console.error('[UserCtrl] uploadAvatar error:', err.message);
    return res.status(500).json({ error: 'Error interno al subir la foto de perfil.' });
  }
}

// ─── POST /kyc ────────────────────────────────────────────────────────────────

/**
 * processKyc
 *
 * Valida los archivos recibidos, registra la aceptación del ToS con IP y
 * user-agent para auditoría, y deja al usuario en 'under_review'.
 *
 * ⚠️ Este endpoint NUNCA aprueba KYC. La aprobación llega solo por dos vías:
 * Stripe Identity (webhook verified) o revisión manual del admin. Flujo legacy
 * de subida manual — el frontend actual usa Stripe Identity (pages/Kyc).
 */
export async function processKyc(req, res) {
  try {
    const userId = req.user._id;

    // ── Validar aceptación del ToS ───────────────────────────────────────
    if (req.body.tosAccepted !== 'true') {
      return res.status(400).json({
        error: 'Debes aceptar los Términos de Servicio para continuar.',
      });
    }

    // ── Validar que se recibieron los tres archivos ──────────────────────
    const frontFiles  = req.files?.documentFront;
    const backFiles   = req.files?.documentBack;
    const selfieFiles = req.files?.selfie;

    if (!frontFiles?.length || !backFiles?.length || !selfieFiles?.length) {
      return res.status(400).json({
        error: 'Se requieren los tres documentos: frente, reverso y selfie.',
      });
    }

    const frontFile  = frontFiles[0];
    const backFile   = backFiles[0];
    const selfieFile = selfieFiles[0];

    // ── Registro de documentos ───────────────────────────────────────────
    const kycDocumentsPayload = [
      { docType: 'document_front',  fileRef: frontFile.originalname,  uploadedAt: new Date() },
      { docType: 'document_back',   fileRef: backFile.originalname,   uploadedAt: new Date() },
      { docType: 'selfie_liveness', fileRef: selfieFile.originalname, uploadedAt: new Date() },
    ];

    // ── Registro de aceptación del ToS para auditoría ────────────────────
    const tosAcceptancePayload = {
      accepted:   true,
      version:    req.body.tosVersion ?? 'unknown',
      entity:     req.user.legalEntity,
      acceptedAt: new Date(),
      ipAddress:  req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.ip ?? '0.0.0.0',
      userAgent:  req.headers['user-agent'] ?? '',
    };

    // ── Actualizar usuario en MongoDB ────────────────────────────────────
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          // Auto-aprobación ELIMINADA (audit 2026-06-11): un usuario autenticado
          // podía aprobarse su propio KYC subiendo 3 archivos cualesquiera.
          kycStatus:     'under_review',
          kycProvider:   'manual_upload',
          tosAcceptance: tosAcceptancePayload,
        },
        $push: {
          kycDocuments: { $each: kycDocumentsPayload },
        },
      },
      { returnDocument: 'after', select: '-password -__v' },
    );

    if (!updatedUser) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    console.info(`[KYC] Usuario ${userId} — kycStatus actualizado a '${updatedUser.kycStatus}'`);

    return res.status(200).json({
      message: 'Verificación recibida correctamente.',
      user: {
        id:          updatedUser._id,
        email:       updatedUser.email,
        firstName:   updatedUser.firstName,
        lastName:    updatedUser.lastName,
        legalEntity: updatedUser.legalEntity,
        kycStatus:   updatedUser.kycStatus,
        country:     updatedUser.residenceCountry,
      },
    });
  } catch (error) {
    console.error('[KYC] Error en processKyc:', error.message);
    return res.status(500).json({
      error: 'Error interno al procesar la verificación de identidad.',
    });
  }
}
