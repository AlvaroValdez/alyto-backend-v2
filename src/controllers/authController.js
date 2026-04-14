/**
 * authController.js — Registro y Login de Usuarios Multi-Entidad
 *
 * registerUser: Crea cuenta, asigna legalEntity según country y devuelve JWT.
 * loginUser:    Valida credenciales y devuelve JWT firmado.
 *
 * Mapeo de country → legalEntity (ISO 3166-1 alpha-2):
 *   CL → SpA  (AV Finance SpA — Chile)
 *   BO → SRL  (AV Finance SRL — Bolivia)
 *   US → LLC  (AV Finance LLC — Delaware)
 *   *  → LLC  (resto del mundo, por defecto entidad matriz)
 */

import crypto   from 'crypto';
import bcrypt   from 'bcryptjs';
import jwt      from 'jsonwebtoken';
import sgMail   from '@sendgrid/mail';
import User     from '../models/User.js';
import { getDefaultCurrency } from '../utils/entityMaps.js';
import { sendEmail, EMAILS }  from '../services/email.js';
import { notifyAdmins, NOTIFICATIONS } from '../services/notifications.js';
import { invalidateUserCache } from '../middlewares/authMiddleware.js';

// ─── Mapeo de país a entidad legal ────────────────────────────────────────────

const COUNTRY_TO_ENTITY = {
  CL: 'SpA',
  BO: 'SRL',
  US: 'LLC',
};

/**
 * Resuelve la entidad legal AV Finance según el país de residencia del usuario.
 * Usuarios fuera de CL/BO/US operan bajo la entidad matriz LLC por defecto.
 *
 * @param {string} country — ISO 3166-1 alpha-2 (ej. 'CL', 'BO', 'US')
 * @returns {'LLC'|'SpA'|'SRL'}
 */
function resolveEntity(country) {
  return COUNTRY_TO_ENTITY[country?.toUpperCase()] ?? 'LLC';
}

// ─── Tipo de documento predeterminado por entidad ─────────────────────────────

const ENTITY_DEFAULT_DOC = {
  SpA: 'rut',
  SRL: 'ci_bolivia',
  LLC: 'passport',
};

// ─── Generación de JWT ────────────────────────────────────────────────────────

/**
 * Genera un JWT firmado con id + tokenVersion (para revocación server-side).
 * @param {string|ObjectId} userId
 * @param {number}          tokenVersion — valor actual del contador del user
 * @param {string}          [expiresIn]  — sobreescribe JWT_EXPIRES_IN del entorno
 * @returns {string} Token JWT
 */
function generateToken(userId, tokenVersion, expiresIn) {
  return jwt.sign(
    { id: userId, tokenVersion: tokenVersion ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: expiresIn ?? process.env.JWT_EXPIRES_IN ?? '24h' },
  );
}

/**
 * Opciones estándar de la cookie HttpOnly de autenticación.
 * @param {boolean} rememberMe — true => 7 días; false => 24 horas
 */
export function authCookieOptions(rememberMe) {
  return {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge:   rememberMe ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000,
    path:     '/',
  };
}

export const AUTH_COOKIE_NAME = 'alyto_token';

/** Genera el hash SHA-256 de un token en texto claro. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── registerUser ─────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/register
 *
 * Registra un nuevo usuario. Asigna automáticamente la entidad legal (LLC, SpA,
 * SRL) según el country recibido y deja el kycStatus en 'pending'.
 *
 * Body requerido: { email, password, country }
 * Body opcional:  { firstName, lastName, phone }
 *
 * Respuesta 201: { token, user: { id, email, legalEntity, kycStatus } }
 */
export async function registerUser(req, res) {
  try {
    const {
      email, password, country, firstName, lastName, phone,
      termsAccepted, termsAcceptedAt, termsVersion,
    } = req.body;

    // ── Validación de campos obligatorios ──────────────────────────────────
    if (!email || !password || !country) {
      return res.status(400).json({
        error: 'Los campos email, password y country son requeridos.',
      });
    }

    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({
        error: 'La contraseña debe tener al menos 8 caracteres.',
      });
    }

    if (!termsAccepted) {
      return res.status(400).json({
        error: 'Debes aceptar los Términos y Condiciones para continuar.',
      });
    }

    const countryCode = String(country).toUpperCase();
    const normalizedEmail = String(email).toLowerCase().trim();

    // ── Verificar duplicado antes de hashear ───────────────────────────────
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({
        error: 'El email ya está registrado.',
      });
    }

    // ── Hash de contraseña (cost factor 10 — balance seg/rendimiento) ──────
    const passwordHash = await bcrypt.hash(password, 10);

    // ── Asignación automática de entidad legal ─────────────────────────────
    const legalEntity = resolveEntity(countryCode);

    // ── Creación del usuario ───────────────────────────────────────────────
    const user = await User.create({
      firstName:        (typeof firstName === 'string' && firstName.trim()) || 'Usuario',
      lastName:         (typeof lastName === 'string' && lastName.trim())   || 'Alyto',
      email:            normalizedEmail,
      phone:            typeof phone === 'string' ? phone.trim() : undefined,
      password:         passwordHash,
      legalEntity,
      kycStatus:        'pending',
      residenceCountry: countryCode,
      preferences:      { currency: getDefaultCurrency(countryCode) },
      // Documento pendiente de verificación — se completa en el flujo KYC
      identityDocument: {
        type:           ENTITY_DEFAULT_DOC[legalEntity],
        number:         'PENDING_VERIFICATION',
        issuingCountry: countryCode,
      },
      // Auditoría de aceptación legal — requerido GDPR / Ley 19.628 / ASFI
      tosAcceptance: {
        accepted:   true,
        version:    typeof termsVersion === 'string' ? termsVersion : '2.0',
        entity:     legalEntity,
        acceptedAt: termsAcceptedAt ? new Date(termsAcceptedAt) : new Date(),
        ipAddress:  req.ip,
        userAgent:  req.get('user-agent') ?? null,
      },
    });

    const token = generateToken(user._id, user.tokenVersion);

    console.info(`[Auth] Registro exitoso — userId: ${user._id} entity: ${legalEntity}`);

    // Welcome email — fire-and-forget (no bloquear respuesta de registro)
    setImmediate(() => {
      sendEmail(...EMAILS.welcome(user))
        .catch(err => console.error('[Auth] Error enviando welcome email:', err.message));
    });

    // Notificar a admins — push + in-app + email
    const fullName = `${user.firstName} ${user.lastName}`.trim();
    notifyAdmins(NOTIFICATIONS.adminNewUser(fullName, user.email, legalEntity)).catch(() => {});

    res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions(false));

    return res.status(201).json({
      user: {
        id:          user._id,
        email:       user.email,
        legalEntity: user.legalEntity,
        kycStatus:   user.kycStatus,
        role:        user.role,
      },
    });

  } catch (err) {
    console.error('[Auth] Error en registerUser:', err.message);
    return res.status(500).json({ error: 'Error al registrar usuario.' });
  }
}

// ─── getMe ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/auth/me
 *
 * Valida el token activo y devuelve el perfil fresco del usuario desde la DB.
 * El middleware protect() ya verificó la firma y cargó req.user.
 *
 * Respuesta 200: { user: { id, email, firstName, lastName, legalEntity, kycStatus, role, country } }
 */
export async function getMe(req, res) {
  const { _id, email, firstName, lastName, legalEntity, role, country, avatarUrl } = req.user;

  // Leer kycStatus directo de la DB — el middleware tiene caché de 5 min
  // que puede quedar desactualizado justo cuando el KYC cambia a 'approved'.
  let kycStatus = req.user.kycStatus;
  try {
    const fresh = await User.findById(_id).select('kycStatus kycApprovedAt').lean();
    if (fresh) kycStatus = fresh.kycStatus;
  } catch {
    // Si falla la query, devolver lo que tiene el middleware (mejor que nada)
  }

  // Leer accountType y kybStatus frescos de BD
  let accountType = req.user.accountType;
  let kybStatus   = req.user.kybStatus;
  try {
    const freshBiz = await User.findById(_id).select('accountType kybStatus').lean();
    if (freshBiz) {
      accountType = freshBiz.accountType;
      kybStatus   = freshBiz.kybStatus;
    }
  } catch { /* fallback a lo que tiene el middleware */ }

  return res.json({
    user: { id: _id, email, firstName, lastName, legalEntity, kycStatus, kybStatus, accountType, role, country, avatarUrl: avatarUrl ?? null },
  });
}

// ─── loginUser ────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/login
 *
 * Valida credenciales y devuelve un JWT firmado junto al perfil básico del usuario.
 * El mensaje de error es deliberadamente genérico para no revelar si el email existe.
 *
 * Body: { email, password }
 * Respuesta 200: { token, user: { id, email, legalEntity, kycStatus } }
 */
export async function loginUser(req, res) {
  try {
    const { email, password } = req.body;

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({
        error: 'Los campos email y password son requeridos.',
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    // Cargar con +password (campo oculto por select:false en el modelo)
    // .lean() devuelve POJO en lugar de documento Mongoose — ~2-5x más rápido
    const user = await User.findOne({ email: normalizedEmail }).select('+password').lean();

    // Mensaje genérico — no revelar si el email existe (prevención de user enumeration)
    if (!user || !user.password) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    if (!user.isActive) {
      return res.status(401).json({ error: 'Cuenta suspendida. Contacta soporte.' });
    }

    // lastLoginAt siempre — fire-and-forget, no bloquea la respuesta
    // Re-hash progresivo: si el hash tiene cost > 10, migrar silenciosamente
    // IMPORTANTE: bcrypt.hash() es costoso (~500ms) — se ejecuta DESPUÉS de
    // enviar la respuesta usando setImmediate para no bloquear el login.
    const currentRounds = parseInt(user.password.split('$')[2], 10);
    const TARGET_COST   = 10;
    setImmediate(async () => {
      try {
        const updates = { lastLoginAt: new Date() };
        if (currentRounds > TARGET_COST) {
          updates.password = await bcrypt.hash(password, TARGET_COST);
        }
        await User.findByIdAndUpdate(user._id, updates);
      } catch (err) {
        console.warn('[Auth] Error en background update post-login:', err.message);
      }
    });

    // rememberMe: true → 7 días; false/ausente → 24 horas (reducido desde 30d/7d)
    const rememberMe = req.body.rememberMe === true;
    const jwtExpiry  = rememberMe ? '7d' : '24h';

    const token = generateToken(user._id, user.tokenVersion, jwtExpiry);

    console.info(`[Auth] Login exitoso — userId: ${user._id} | entity: ${user.legalEntity}`);

    res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions(rememberMe));

    return res.json({
      user: {
        id:          user._id,
        email:       user.email,
        firstName:   user.firstName,
        lastName:    user.lastName,
        legalEntity: user.legalEntity,
        kycStatus:   user.kycStatus,
        kybStatus:   user.kybStatus,
        accountType: user.accountType,
        role:        user.role,
        country:     user.country,
        avatarUrl:   user.avatarUrl ?? null,
      },
    });

  } catch (err) {
    console.error('[Auth] Error en loginUser:', err.message);
    return res.status(500).json({ error: 'Error al iniciar sesión.' });
  }
}

// ─── forgotPassword ───────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/forgot-password
 *
 * Genera un token de reset y envía el email con el enlace.
 * La respuesta es siempre 200 para no revelar si el email existe.
 *
 * Body: { email }
 * Respuesta 200: { message: "..." }
 */
export async function forgotPassword(req, res) {
  const { email } = req.body

  // Respuesta genérica para evitar user enumeration
  const SUCCESS_MSG = 'Si ese email está registrado, recibirás las instrucciones en tu bandeja de entrada.'

  if (typeof email !== 'string' || !email) {
    return res.status(400).json({ error: 'El campo email es requerido.' })
  }

  try {
    const user = await User.findOne({ email: String(email).toLowerCase().trim() })

    // Si el usuario no existe, respondemos igual — no revelamos que el email no existe
    if (!user) {
      return res.json({ message: SUCCESS_MSG })
    }

    // Generar token aleatorio (texto claro para el email) y su hash para la BD
    const rawToken  = crypto.randomBytes(32).toString('hex')
    const tokenHash = hashToken(rawToken)

    // Persistir hash + expiración (1 hora)
    user.passwordResetToken   = tokenHash
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000)
    await user.save()

    // Enviar email con el link de reset
    const APP_URL   = process.env.APP_URL ?? 'http://localhost:5173'
    const resetLink = `${APP_URL}/reset-password/${rawToken}`

    // Fire-and-forget: no bloquea la respuesta si el email falla
    if (process.env.SENDGRID_API_KEY) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY)
      sgMail.send({
        to:      user.email,
        from:    process.env.SENDGRID_FROM_EMAIL ?? 'noreply@alyto.app',
        subject: 'Restablece tu contraseña — Alyto',
        html: `
          <div style="font-family:Inter,sans-serif;max-width:480px;margin:auto;padding:32px;background:#0F1628;color:#fff;border-radius:16px">
            <h2 style="color:#C4CBD8;margin-bottom:8px">Restablecer contraseña</h2>
            <p style="color:#8A96B8">Hola <strong style="color:#fff">${user.firstName}</strong>,</p>
            <p style="color:#8A96B8">Recibimos una solicitud para restablecer la contraseña de tu cuenta Alyto.</p>
            <div style="margin:24px 0;text-align:center">
              <a href="${resetLink}" style="display:inline-block;padding:14px 28px;background:#C4CBD8;color:#0F1628;border-radius:12px;font-weight:700;text-decoration:none;font-size:15px">
                Restablecer contraseña
              </a>
            </div>
            <p style="color:#4E5A7A;font-size:13px">Este enlace expira en 1 hora.<br>Si no solicitaste este cambio, ignora este email.</p>
            <p style="color:#263050;font-size:11px;margin-top:24px">AV Finance LLC · SpA · SRL</p>
          </div>
        `,
      }).catch(err => console.error('[Auth] Error enviando email de reset:', err.message))
    }

    console.info(`[Auth] Token de reset generado — userId: ${user._id}`)
    return res.json({ message: SUCCESS_MSG })

  } catch (err) {
    console.error('[Auth] Error en forgotPassword:', err.message)
    return res.status(500).json({ error: 'Error al procesar la solicitud.' })
  }
}

// ─── resetPassword ────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/reset-password
 *
 * Valida el token y actualiza la contraseña del usuario.
 *
 * Body: { token, newPassword }
 * Respuesta 200: { message: "Contraseña actualizada exitosamente." }
 */
export async function resetPassword(req, res) {
  const { token, newPassword } = req.body

  if (typeof token !== 'string' || typeof newPassword !== 'string' || !token || !newPassword) {
    return res.status(400).json({ error: 'Los campos token y newPassword son requeridos.' })
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' })
  }

  try {
    const tokenHash = hashToken(String(token))

    // Buscar usuario con el token válido y no expirado
    const user = await User.findOne({
      passwordResetToken:   tokenHash,
      passwordResetExpires: { $gt: new Date() },
    }).select('+passwordResetToken +passwordResetExpires')

    if (!user) {
      return res.status(400).json({
        error: 'El enlace de restablecimiento es inválido o ha expirado.',
        expired: true,
      })
    }

    // Actualizar contraseña, invalidar tokens existentes y limpiar campos de reset
    user.password             = await bcrypt.hash(newPassword, 10)
    user.tokenVersion         = (user.tokenVersion ?? 0) + 1
    user.passwordResetToken   = undefined
    user.passwordResetExpires = undefined
    await user.save()

    invalidateUserCache(String(user._id))

    console.info(`[Auth] Contraseña restablecida — userId: ${user._id}`)
    return res.json({ message: 'Contraseña actualizada exitosamente.' })

  } catch (err) {
    console.error('[Auth] Error en resetPassword:', err.message)
    return res.status(500).json({ error: 'Error al restablecer la contraseña.' })
  }
}

// ─── registerFcmToken ─────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/fcm-token
 * Requiere JWT (middleware protect).
 *
 * Registra un token FCM para el dispositivo actual del usuario.
 * Usa $addToSet para evitar duplicados. Limita a 5 tokens por usuario:
 * si se supera el límite, elimina el primero (más antiguo) para hacer espacio.
 *
 * Body: { token: string }
 * Respuesta 200: { message: "Token registrado" }
 */
export async function registerFcmToken(req, res) {
  const { token } = req.body;

  if (!token || typeof token !== 'string' || token.trim() === '') {
    return res.status(400).json({ error: 'El campo token es requerido.' });
  }

  const fcmToken = token.trim();

  try {
    const user = await User.findById(req.user.id).select('fcmTokens');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    // Agregar token si no existe ya
    if (!user.fcmTokens.includes(fcmToken)) {
      // Mantener máximo 5 tokens — descartar el más antiguo si se supera
      if (user.fcmTokens.length >= 5) {
        user.fcmTokens.shift(); // elimina el índice 0 (el más antiguo)
      }
      user.fcmTokens.push(fcmToken);
      await user.save();

      console.info('[Auth] Token FCM registrado.', {
        userId:     req.user.id,
        totalTokens: user.fcmTokens.length,
      });
    }

    return res.json({ message: 'Token registrado' });

  } catch (err) {
    console.error('[Auth] Error registrando token FCM:', err.message);
    return res.status(500).json({ error: 'Error al registrar token.' });
  }
}

// ─── logoutUser ───────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/logout
 * Incrementa tokenVersion (revocando todos los JWTs activos del usuario),
 * limpia el cache del middleware y la cookie HttpOnly.
 */
export async function logoutUser(req, res) {
  try {
    const userId = req.user?.id ?? req.user?._id;
    if (userId) {
      await User.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } });
      invalidateUserCache(String(userId));
    }
    res.clearCookie(AUTH_COOKIE_NAME, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path:     '/',
    });
    return res.json({ message: 'Sesión cerrada.' });
  } catch (err) {
    console.error('[Auth] Error en logoutUser:', err.message);
    return res.status(500).json({ error: 'Error al cerrar sesión.' });
  }
}
