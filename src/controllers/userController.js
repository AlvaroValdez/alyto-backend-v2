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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Regex para contraseña segura: ≥8 chars, 1 mayúscula, 1 número, 1 símbolo */
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

/** Moneda principal según entidad legal del usuario */
const ENTITY_CURRENCY_MAP = { SpA: 'CLP', SRL: 'BOB', LLC: 'USD' };

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
    createdAt:      user.createdAt,
    fcmTokens:      (user.fcmTokens ?? []).length,
    preferences: {
      language: user.preferences?.language  ?? 'es',
      currency: user.preferences?.currency  ?? ENTITY_CURRENCY_MAP[user.legalEntity] ?? 'CLP',
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
      { new: true, runValidators: true },
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Usuario no encontrado.' });

    return res.status(200).json(buildProfileResponse(updated));
  } catch (err) {
    console.error('[UserCtrl] updateProfile error:', err.message);
    return res.status(500).json({ error: 'Error interno al actualizar el perfil.' });
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

// ─── POST /kyc ────────────────────────────────────────────────────────────────

/**
 * processKyc
 *
 * Valida los archivos recibidos, registra la aceptación del ToS con IP y
 * user-agent para auditoría, y actualiza kycStatus del usuario a 'approved'.
 *
 * En producción: cambiar kycStatus a 'under_review' y enviar a proveedor
 * KYC externo (Stripe Identity, Jumio, etc.). Subir archivos a S3/GCS.
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
      entity:     req.body.legalEntity ?? req.user.legalEntity,
      acceptedAt: new Date(),
      ipAddress:  req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.ip ?? '0.0.0.0',
      userAgent:  req.headers['user-agent'] ?? '',
    };

    // ── Actualizar usuario en MongoDB ────────────────────────────────────
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          kycStatus:     'approved',  // 'under_review' en producción
          kycApprovedAt: new Date(),
          kycProvider:   'manual_upload',
          tosAcceptance: tosAcceptancePayload,
        },
        $push: {
          kycDocuments: { $each: kycDocumentsPayload },
        },
      },
      { new: true, select: '-password -__v' },
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
