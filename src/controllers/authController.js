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
import WalletBOB    from '../models/WalletBOB.js';
import WalletUSDC   from '../models/WalletUSDC.js';
import Transaction  from '../models/Transaction.js';
import { getDefaultCurrency } from '../utils/entityMaps.js';
import { sendEmail, EMAILS, sendRawEmail, sendWelcomeEmail, sendVerificationCodeEmail } from '../services/email.js';
import { notifyAdmins, NOTIFICATIONS } from '../services/notifications.js';
import { invalidateUserCache } from '../middlewares/authMiddleware.js';

// ─── Mapeo de país a entidad legal ────────────────────────────────────────────

// ─── Dual auth mode ──────────────────────────────────────────────────────────
// AUTH_MODE=cookie (default, VPS prod)  → HttpOnly cookie + token in body (belt-and-suspenders)
// AUTH_MODE=header (Render staging)     → token in JSON body, no cookie
const AUTH_MODE     = process.env.AUTH_MODE ?? 'cookie';
const IS_HEADER_MODE = AUTH_MODE === 'header';

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
 *
 * Dos modos de despliegue soportados:
 *  1. Cross-origin (default en Render): frontend y backend en subdominios
 *     distintos de onrender.com (cross-site per Public Suffix List). XHR
 *     credenciada requiere `SameSite=None + Secure`.
 *  2. Same-site custom domain: setear `COOKIE_DOMAIN=.alyto.app` cuando
 *     frontend y API vivan bajo el mismo registrable (ej: app.alyto.app +
 *     api.alyto.app). Entonces `SameSite=Lax` basta y es más resiliente
 *     frente a políticas estrictas de cookies de terceros en iOS/Android.
 *
 * @param {boolean} rememberMe — true => 7 días; false => 24 horas
 */
export function authCookieOptions(rememberMe) {
  const isProd       = process.env.NODE_ENV === 'production';
  const cookieDomain = process.env.COOKIE_DOMAIN || null;
  // Si hay COOKIE_DOMAIN asumimos despliegue same-site (cookie compartida
  // entre subdominios del mismo registrable) → Lax alcanza. Si no, asumimos
  // cross-origin y necesitamos None+Secure.
  const sameSite     = cookieDomain ? 'lax' : (isProd ? 'none' : 'lax');

  return {
    httpOnly: true,
    secure:   isProd,
    sameSite,
    maxAge:   rememberMe ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000,
    path:     '/',
    ...(cookieDomain && { domain: cookieDomain }),
  };
}

export const AUTH_COOKIE_NAME = 'alyto_token';

/** Genera el hash SHA-256 de un token en texto claro. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── Verificación de email ────────────────────────────────────────────────────
const EMAIL_CODE_TTL_MS      = 15 * 60 * 1000; // 15 min de validez del código
const EMAIL_RESEND_COOLDOWN_MS = 60 * 1000;    // 60s entre reenvíos
const EMAIL_MAX_ATTEMPTS      = 5;             // intentos fallidos antes de exigir reenvío

/** Genera un código numérico de 6 dígitos criptográficamente seguro. */
function generateEmailCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
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
      termsAccepted, termsAcceptedAt, termsVersion, documentNumber,
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

    // Versión vigente de T&C — no bloquea si el cliente envía una versión
    // anterior (para no rechazar usuarios existentes), pero queda registrado
    // en logs para auditoría de compliance.
    const CURRENT_TERMS_VERSION = '2.1';
    if (termsVersion !== CURRENT_TERMS_VERSION) {
      console.warn('[Auth] User accepted old T&C version:', termsVersion);
    }

    const countryCode = String(country).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      return res.status(400).json({
        error: 'El país debe ser un código ISO de 2 letras (ej. BO, CL, US).',
      });
    }
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

    // ── Código de verificación de email (6 dígitos, hash en reposo) ─────────
    const emailCode = generateEmailCode();
    const nowTs     = new Date();

    // ── Creación del usuario ───────────────────────────────────────────────
    const user = await User.create({
      firstName:        (typeof firstName === 'string' && firstName.trim()) || 'Usuario',
      lastName:         (typeof lastName === 'string' && lastName.trim())   || 'Alyto',
      email:            normalizedEmail,
      phone:            typeof phone === 'string' ? phone.trim() : undefined,
      password:         passwordHash,
      legalEntity,
      kycStatus:        'pending',
      emailVerified:    false,
      emailVerificationCode:     hashToken(emailCode),
      emailVerificationExpires:  new Date(nowTs.getTime() + EMAIL_CODE_TTL_MS),
      emailVerificationLastSent: nowTs,
      residenceCountry: countryCode,
      preferences:      { currency: getDefaultCurrency(countryCode) },
      // Documento del cliente: si el onboarding ya lo declara, se guarda; si no,
      // queda 'PENDING_VERIFICATION' hasta capturarse en el flujo KYC.
      identityDocument: {
        type:           ENTITY_DEFAULT_DOC[legalEntity],
        number:         (typeof documentNumber === 'string' && documentNumber.trim().length >= 4)
                          ? documentNumber.trim()
                          : 'PENDING_VERIFICATION',
        issuingCountry: countryCode,
      },
      // Auditoría de aceptación legal — requerido GDPR / Ley 19.628 / ASFI
      tosAcceptance: {
        accepted:   true,
        version:    typeof termsVersion === 'string' ? termsVersion : CURRENT_TERMS_VERSION,
        entity:     legalEntity,
        acceptedAt: termsAcceptedAt ? new Date(termsAcceptedAt) : new Date(),
        ipAddress:  req.ip,
        userAgent:  req.get('user-agent') ?? null,
      },
    });

    const token = generateToken(user._id, user.tokenVersion);

    console.info(`[Auth] Registro exitoso — userId: ${user._id} entity: ${legalEntity}`);

    // Código de verificación de email — fire-and-forget (no bloquea el registro).
    setImmediate(() => {
      sendVerificationCodeEmail(user, emailCode, EMAIL_CODE_TTL_MS / 60000)
        .catch(err => console.error('[Auth] Error enviando código de verificación:', err.message));
    });

    // Welcome email — fire-and-forget (no bloquear respuesta de registro).
    // sendWelcomeEmail usa SendGrid Dynamic Template si SENDGRID_TEMPLATE_WELCOME
    // está configurado; si no, envía HTML inline (fallback).
    console.log('[Auth] Sending welcome email to:', user.email);
    setImmediate(() => {
      sendWelcomeEmail(user)
        .catch(err => console.error('[Auth] Error enviando welcome email:', err.message, err.response?.body));
    });

    // Notificar a admins — push + in-app + email
    const fullName = `${user.firstName} ${user.lastName}`.trim();
    notifyAdmins(NOTIFICATIONS.adminNewUser(fullName, user.email, legalEntity)).catch(() => {});

    if (!IS_HEADER_MODE) res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions(false));

    return res.status(201).json({
      token,
      user: {
        id:          user._id,
        email:       user.email,
        firstName:   user.firstName,
        lastName:    user.lastName,
        legalEntity:         user.legalEntity,
        kycStatus:           user.kycStatus,
        emailVerified:       user.emailVerified,
        kycProfileCompleted: false,
        role:                user.role,
        country:             user.residenceCountry,
      },
    });

  } catch (err) {
    // Carrera de registro concurrente con el mismo email: el check previo pasó
    // en ambos requests pero el índice único lo rechaza — responder como duplicado.
    if (err.code === 11000) {
      return res.status(409).json({ error: 'El email ya está registrado.' });
    }
    console.error('[Auth] Error en registerUser:', err.message);
    return res.status(500).json({ error: 'Error al registrar usuario.' });
  }
}

// ─── verifyEmail ──────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/verify-email   (protegido)
 * Body: { code }  — código de 6 dígitos enviado al email del usuario.
 * Marca emailVerified=true si el código es correcto y vigente.
 */
export async function verifyEmail(req, res) {
  try {
    const { code } = req.body ?? {};
    if (!code || !/^\d{6}$/.test(String(code).trim())) {
      return res.status(400).json({ error: 'Ingresa el código de 6 dígitos.', code: 'INVALID_FORMAT' });
    }

    const user = await User.findById(req.user._id)
      .select('+emailVerificationCode +emailVerificationExpires +emailVerificationAttempts');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
    if (user.emailVerified) return res.status(200).json({ emailVerified: true });

    if (!user.emailVerificationCode || !user.emailVerificationExpires) {
      return res.status(400).json({ error: 'No hay un código vigente. Solicita uno nuevo.', code: 'NO_CODE' });
    }
    if (user.emailVerificationExpires.getTime() < Date.now()) {
      return res.status(400).json({ error: 'El código expiró. Solicita uno nuevo.', code: 'EXPIRED' });
    }
    if ((user.emailVerificationAttempts ?? 0) >= EMAIL_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Demasiados intentos. Solicita un código nuevo.', code: 'TOO_MANY_ATTEMPTS' });
    }

    if (hashToken(String(code).trim()) !== user.emailVerificationCode) {
      user.emailVerificationAttempts = (user.emailVerificationAttempts ?? 0) + 1;
      await user.save();
      const left = Math.max(0, EMAIL_MAX_ATTEMPTS - user.emailVerificationAttempts);
      return res.status(400).json({ error: `Código incorrecto. Te quedan ${left} intentos.`, code: 'INVALID', attemptsLeft: left });
    }

    user.emailVerified             = true;
    user.emailVerificationCode     = undefined;
    user.emailVerificationExpires  = undefined;
    user.emailVerificationAttempts = 0;
    await user.save();
    invalidateUserCache(user._id); // refrescar cache de protect()

    console.info(`[Auth] Email verificado — userId: ${user._id}`);
    return res.status(200).json({ emailVerified: true });
  } catch (err) {
    console.error('[Auth] Error en verifyEmail:', err.message);
    return res.status(500).json({ error: 'Error al verificar el email.' });
  }
}

// ─── resendVerification ─────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/resend-verification   (protegido)
 * Genera y reenvía un nuevo código de verificación, con cooldown de 60s.
 */
export async function resendVerification(req, res) {
  try {
    const user = await User.findById(req.user._id).select('+emailVerificationLastSent');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
    if (user.emailVerified) return res.status(200).json({ emailVerified: true });

    if (user.emailVerificationLastSent) {
      const elapsed = Date.now() - user.emailVerificationLastSent.getTime();
      if (elapsed < EMAIL_RESEND_COOLDOWN_MS) {
        const wait = Math.ceil((EMAIL_RESEND_COOLDOWN_MS - elapsed) / 1000);
        return res.status(429).json({ error: `Espera ${wait}s antes de pedir otro código.`, retryAfter: wait });
      }
    }

    const code = generateEmailCode();
    user.emailVerificationCode     = hashToken(code);
    user.emailVerificationExpires  = new Date(Date.now() + EMAIL_CODE_TTL_MS);
    user.emailVerificationAttempts = 0;
    user.emailVerificationLastSent = new Date();
    await user.save();

    setImmediate(() => {
      sendVerificationCodeEmail(user, code, EMAIL_CODE_TTL_MS / 60000)
        .catch(err => console.error('[Auth] Error reenviando código:', err.message));
    });

    return res.status(200).json({ ok: true, message: 'Código reenviado.' });
  } catch (err) {
    console.error('[Auth] Error en resendVerification:', err.message);
    return res.status(500).json({ error: 'Error al reenviar el código.' });
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
  // Incluye también el estado de onboarding (email + info de cumplimiento) que
  // el router del frontend usa para enrutar verify-email → kyc-profile → KYC.
  let kycStatus           = req.user.kycStatus;
  let emailVerified       = req.user.emailVerified === true;
  let kycProfileCompleted = !!req.user.kycProfileCompletedAt;
  try {
    const fresh = await User.findById(_id)
      .select('kycStatus kycApprovedAt emailVerified kycProfileCompletedAt').lean();
    if (fresh) {
      kycStatus           = fresh.kycStatus;
      emailVerified       = fresh.emailVerified === true;
      kycProfileCompleted = !!fresh.kycProfileCompletedAt;
    }
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
    user: { id: _id, email, firstName, lastName, legalEntity, kycStatus, kybStatus, accountType, role, country, avatarUrl: avatarUrl ?? null, emailVerified, kycProfileCompleted },
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

    if (!IS_HEADER_MODE) res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions(rememberMe));

    const responseBody = {
      token,
      user: {
        id:          user._id,
        email:       user.email,
        firstName:   user.firstName,
        lastName:    user.lastName,
        legalEntity: user.legalEntity,
        kycStatus:           user.kycStatus,
        kybStatus:           user.kybStatus,
        accountType:         user.accountType,
        emailVerified:       user.emailVerified === true,
        kycProfileCompleted: !!user.kycProfileCompletedAt,
        role:                user.role,
        country:             user.country,
        avatarUrl:           user.avatarUrl ?? null,
      },
    };

    return res.json(responseBody);

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
    const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173'
    const resetLink    = `${FRONTEND_URL}/reset-password/${rawToken}`

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
      // Sólo incrementar tokenVersion en producción. En dev, logout/login
      // repetidos generan drift en el contador y rompen tokens cacheados.
      if (process.env.NODE_ENV === 'production') {
        await User.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } });
      }
      invalidateUserCache(String(userId));
    }
    if (!IS_HEADER_MODE) {
      const { maxAge: _ignored, ...clearOpts } = authCookieOptions(false);
      res.clearCookie(AUTH_COOKIE_NAME, clearOpts);
    }
    return res.json({ message: 'Sesión cerrada.' });
  } catch (err) {
    console.error('[Auth] Error en logoutUser:', err.message);
    return res.status(500).json({ error: 'Error al cerrar sesión.' });
  }
}

// ─── deleteAccount ──────────────────────────────────────────────────────────────

/**
 * DELETE /api/v1/auth/account   (protegido)
 *
 * Eliminación de cuenta solicitada por el usuario — requisito duro de Google
 * Play (apps con creación de cuenta deben ofrecer borrado in-app + URL web) y
 * de GDPR / Ley 19.628 (CL).
 *
 * ⚠️ NO es un hard-delete. Alyto es un PSAV custodial (DS 5384, Cap. XI) sujeto a
 * retención de registros AML/CFT. Por eso este flujo:
 *   1. Re-autentica al usuario con su contraseña.
 *   2. Bloquea si quedan FONDOS (BOB/USDC: disponible + reservado + congelado) o
 *      TRANSACCIONES en curso — para no perder dinero del usuario.
 *   3. Desactiva la cuenta, revoca todos los JWTs, borra tokens push y libera el
 *      alias, y anonimiza la PII de contacto no regulatoria (teléfono, avatar).
 *   4. RETIENE identidad/KYC/transacciones/ToS durante el plazo legal (la purga
 *      final corre después de la retención → deletionStatus 'anonymized').
 *
 * Body: { password: string, confirm: true }
 * Respuesta 200: { message, deletionStatus, retainedForCompliance: true }
 */
export async function deleteAccount(req, res) {
  try {
    const { password, confirm } = req.body ?? {};

    if (confirm !== true) {
      return res.status(400).json({
        error: 'Debes confirmar explícitamente la eliminación (confirm: true).',
        code:  'CONFIRM_REQUIRED',
      });
    }
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({
        error: 'Ingresa tu contraseña para confirmar la eliminación.',
        code:  'PASSWORD_REQUIRED',
      });
    }

    const userId = req.user?.id ?? req.user?._id;

    // Los admins no pueden auto-eliminarse por este endpoint (evita lockout del
    // backoffice). La baja de un admin la gestiona otro admin.
    if (req.user?.role === 'admin') {
      return res.status(403).json({
        error: 'Las cuentas de administrador no pueden eliminarse desde aquí.',
        code:  'ADMIN_FORBIDDEN',
      });
    }

    // ── Re-autenticación con contraseña ──────────────────────────────────────
    const user = await User.findById(userId).select('+password');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    if (user.deletionStatus === 'deletion_requested') {
      return res.status(409).json({
        message:        'Tu cuenta ya tiene una solicitud de eliminación en curso.',
        deletionStatus: user.deletionStatus,
      });
    }

    const passwordOk = user.password && await bcrypt.compare(password, user.password);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Contraseña incorrecta.', code: 'INVALID_PASSWORD' });
    }

    // ── Guard 1: fondos remanentes (no perder dinero del usuario) ────────────
    const EPS = 1e-6;
    const [walletBob, walletUsdc] = await Promise.all([
      WalletBOB.findOne({ userId }).lean(),
      WalletUSDC.findOne({ userId }).lean(),
    ]);
    const bobTotal  = walletBob  ? (walletBob.balance  ?? 0) + (walletBob.balanceReserved  ?? 0) + (walletBob.balanceFrozen  ?? 0) : 0;
    const usdcTotal = walletUsdc ? (walletUsdc.balance ?? 0) + (walletUsdc.balanceReserved ?? 0) + (walletUsdc.balanceFrozen ?? 0) : 0;
    if (bobTotal > EPS || usdcTotal > EPS) {
      return res.status(409).json({
        error: 'Tienes saldo en tu wallet. Retira tus fondos antes de eliminar la cuenta.',
        code:  'BALANCE_NOT_ZERO',
        balances: { bob: bobTotal, usdc: usdcTotal },
      });
    }

    // ── Guard 2: transacciones en curso ──────────────────────────────────────
    const TERMINAL = ['completed', 'failed', 'refunded', 'cancelled'];
    const inFlight = await Transaction.countDocuments({
      userId,
      archivedAt: null,
      status:     { $nin: TERMINAL },
    });
    if (inFlight > 0) {
      return res.status(409).json({
        error: 'Tienes operaciones en curso. Espera a que finalicen o contacta a soporte antes de eliminar la cuenta.',
        code:  'PENDING_TRANSACTIONS',
        pending: inFlight,
      });
    }

    // ── Baja con retención de cumplimiento ───────────────────────────────────
    const releasedAlias = user.alytoAlias;
    const fullName      = `${user.firstName} ${user.lastName}`.trim();
    const contactEmail  = user.email;
    const entity        = user.legalEntity;

    user.deletionStatus      = 'deletion_requested';
    user.deletionRequestedAt = new Date();
    user.isActive            = false;
    user.tokenVersion        = (user.tokenVersion ?? 0) + 1;   // revoca todos los JWTs
    user.fcmTokens           = [];                              // corta el push
    user.alytoAlias          = null;                            // libera el alias P2P
    user.aliasUpdatedAt      = new Date();
    // Anonimiza PII de contacto no regulatoria (identidad/KYC se RETIENEN).
    user.phone               = undefined;
    user.avatarUrl           = null;
    if (user.preferences?.notifications) {
      user.preferences.notifications.email = false;
      user.preferences.notifications.push  = false;
    }
    await user.save();

    invalidateUserCache(String(userId));

    if (!IS_HEADER_MODE) {
      const { maxAge: _ignored, ...clearOpts } = authCookieOptions(false);
      res.clearCookie(AUTH_COOKIE_NAME, clearOpts);
    }

    console.info(`[Auth] Eliminación de cuenta solicitada — userId: ${userId} entity: ${entity}`);

    // Notificar a compliance/admins + confirmación al usuario — fire-and-forget.
    notifyAdmins(NOTIFICATIONS.adminAccountDeletion(fullName, contactEmail, entity)).catch(() => {});
    setImmediate(() => {
      const supportEmail = process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app';
      sendRawEmail(
        contactEmail,
        'Tu cuenta Alyto fue eliminada',
        `
          <div style="font-family:Inter,sans-serif;max-width:480px;margin:auto;padding:32px;background:#0F1628;color:#fff;border-radius:16px">
            <h2 style="color:#C4CBD8;margin-bottom:8px">Cuenta eliminada</h2>
            <p style="color:#8A96B8">Hola <strong style="color:#fff">${fullName}</strong>,</p>
            <p style="color:#8A96B8">Confirmamos que tu cuenta Alyto fue desactivada y tus datos personales fueron eliminados.</p>
            <p style="color:#8A96B8">Por obligación legal (prevención de lavado de activos y normativa ASFI/UIF), conservamos durante el plazo normativo ciertos registros de identidad y de tus operaciones. Estos datos no se usan para fines comerciales.</p>
            <p style="color:#4E5A7A;font-size:13px;margin-top:16px">Si no solicitaste esto, contáctanos de inmediato en ${supportEmail}.</p>
            <p style="color:#263050;font-size:11px;margin-top:24px">AV Finance LLC · SpA · SRL</p>
          </div>
        `,
      ).catch(() => {});
    });

    return res.status(200).json({
      message:               'Tu cuenta fue desactivada y se eliminaron tus datos personales. Algunos registros se conservan por obligación legal (AML/CFT) durante el plazo normativo.',
      deletionStatus:        user.deletionStatus,
      retainedForCompliance: true,
      releasedAlias:         releasedAlias ?? null,
    });

  } catch (err) {
    console.error('[Auth] Error en deleteAccount:', err.message);
    return res.status(500).json({ error: 'Error al procesar la eliminación de la cuenta.' });
  }
}
