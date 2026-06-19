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

export default { chatSupport };
