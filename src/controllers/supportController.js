// src/controllers/supportController.js
//
// AWS-4 — Endpoint del agente IA de soporte para usuarios.
//
// POST /api/v1/support/chat  (protect + supportChatLimiter)
//   body: { message: string, history?: [{ role:'user'|'assistant', text:string }] }
//   resp: { reply: string, source: 'ai' | 'fallback' }
//
// Degradación elegante: si el agente está apagado (BEDROCK_SUPPORT_ENABLED!=true)
// o falla, responde 200 con un mensaje de fallback que deriva a soporte humano.
// El frontend funciona igual con o sin IA activa.

import * as Sentry from '@sentry/node';
import { askSupport, isSupportAgentEnabled } from '../services/supportAgentService.js';
import AiContentReport, { MOTIVOS } from '../models/AiContentReport.js';
import { sendRawEmail } from '../services/email.js';

const MAX_MESSAGE_LEN = 2000;   // tope por mensaje
const MAX_HISTORY      = 10;    // últimos N turnos que se reenvían al modelo
const MAX_HISTORY_LEN  = 1500;  // tope por turno del historial

function supportContact() {
  const email = process.env.SUPPORT_EMAIL || 'soporte@alyto.app';
  const wa    = process.env.SUPPORT_WHATSAPP || '';
  return wa
    ? `Puedes escribirnos a ${email} o por WhatsApp al ${wa}.`
    : `Puedes escribirnos a ${email}.`;
}

function fallbackReply() {
  return `Por ahora no puedo responderte automáticamente. ${supportContact()}`;
}

// Normaliza el historial que envía el cliente: solo roles válidos, texto recortado,
// últimos MAX_HISTORY turnos. Evita inyección de roles arbitrarios.
function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(m => m && typeof m.text === 'string' && m.text.trim())
    .map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text: m.text.trim().slice(0, MAX_HISTORY_LEN),
    }))
    .slice(-MAX_HISTORY);
}

export async function chatSupport(req, res) {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      return res.status(400).json({ error: 'El campo "message" es requerido.' });
    }
    if (message.length > MAX_MESSAGE_LEN) {
      return res.status(400).json({ error: `El mensaje no puede superar ${MAX_MESSAGE_LEN} caracteres.` });
    }

    // Feature gateada: respondemos con fallback (no error) para no romper el UI.
    if (!isSupportAgentEnabled()) {
      return res.json({ reply: fallbackReply(), source: 'fallback' });
    }

    const history = sanitizeHistory(req.body?.history);

    // Contexto NO sensible del usuario (nunca secretos ni datos de terceros).
    const userContext = {
      firstName:        req.user?.firstName,
      accountType:      req.user?.accountType,
      legalEntity:      req.user?.legalEntity,
      residenceCountry: req.user?.residenceCountry,
      kycStatus:        req.user?.kycStatus,
      alytoAlias:       req.user?.alytoAlias,
    };

    const result = await askSupport({ userMessage: message, history, userContext });
    if (!result?.reply) {
      return res.json({ reply: fallbackReply(), source: 'fallback' });
    }

    return res.json({ reply: result.reply, source: 'ai' });
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'supportController', fn: 'chatSupport' } });
    return res.json({ reply: fallbackReply(), source: 'fallback' });
  }
}

/**
 * POST /api/v1/support/report  (protect + supportReportLimiter)
 *   body: { contenido, motivo, mensajeUsuario?, comentario? }
 *   resp: { ok: true, reportId }
 *
 * Denuncia de una respuesta de Aly. Lo exige la política de IA generativa de
 * Google Play: tiene que poder hacerse DENTRO de la app y alguien tiene que
 * atenderla. Por eso además de guardarla se avisa por correo; un registro que
 * nadie mira no cumple el requisito, solo lo aparenta.
 *
 * Se acepta aunque el agente esté apagado: si se apaga justo despues de que el
 * usuario viera una respuesta, la denuncia sigue siendo valida.
 */
export async function reportAiContent(req, res) {
  try {
    const contenido = typeof req.body?.contenido === 'string' ? req.body.contenido.trim() : '';
    const motivo    = typeof req.body?.motivo === 'string' ? req.body.motivo.trim() : '';

    if (!contenido) {
      return res.status(400).json({ error: 'El campo "contenido" es requerido.' });
    }
    if (!MOTIVOS.includes(motivo)) {
      return res.status(400).json({ error: `El campo "motivo" debe ser uno de: ${MOTIVOS.join(', ')}.` });
    }

    const corta = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

    const report = await AiContentReport.create({
      userId:         req.user._id,
      motivo,
      contenido:      contenido.slice(0, 4000),
      mensajeUsuario: corta(req.body?.mensajeUsuario, 2000),
      comentario:     corta(req.body?.comentario, 1000),
    });

    // Aviso a soporte. No bloquea la respuesta: si el correo falla, la denuncia
    // ya esta guardada y el usuario no tiene por que enterarse del fallo.
    const destino = process.env.SUPPORT_EMAIL || 'soporte@alyto.app';
    sendRawEmail(
      destino,
      `[Aly] Denuncia de contenido: ${motivo} (${report.reportId})`,
      `<p><b>Motivo:</b> ${motivo}</p>` +
      `<p><b>Usuario:</b> ${req.user._id}</p>` +
      `<p><b>Mensaje del usuario:</b><br><pre>${escapeHtml(report.mensajeUsuario || '(sin contexto)')}</pre></p>` +
      `<p><b>Respuesta denunciada:</b><br><pre>${escapeHtml(report.contenido)}</pre></p>` +
      (report.comentario ? `<p><b>Comentario:</b><br><pre>${escapeHtml(report.comentario)}</pre></p>` : '') +
      `<p>Revisar y marcar el estado de <code>${report.reportId}</code>.</p>`
    ).catch(err => Sentry.captureException(err, {
      tags: { controller: 'supportController', fn: 'reportAiContent.email' },
    }));

    return res.status(201).json({ ok: true, reportId: report.reportId });
  } catch (err) {
    Sentry.captureException(err, { tags: { controller: 'supportController', fn: 'reportAiContent' } });
    return res.status(500).json({ error: 'No se pudo registrar la denuncia.' });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export default { chatSupport, reportAiContent };
