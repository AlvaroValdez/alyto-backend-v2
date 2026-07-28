// src/controllers/waitlistController.js
//
// Alta en la lista de espera del lanzamiento de alyto.io.
//
// Endpoint público (sin auth): lo consume el formulario de la landing estática,
// que vive en otro dominio (alyto.io) — requiere que ese origen esté en
// ALLOWED_ORIGINS. Protegido por waitlistLimiter + honeypot anti-bot.
//
// Idempotente: reenviar el mismo correo NO es un error ni crea duplicados.
// Devuelve `alreadyRegistered` para que la landing muestre el mensaje correcto.
// Un registro previo que se había dado de baja se reactiva al volver a anotarse.

import { logger } from '../utils/logger.js';
import * as Sentry from '@sentry/node';
import WaitlistEntry from '../models/WaitlistEntry.js';

// Validación deliberadamente permisiva: rechaza lo evidentemente inválido sin
// descartar correos legítimos poco comunes. El filtro real es la confirmación.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Recorta y normaliza un campo de texto opcional del cuerpo de la petición.
function clean(value, maxLength) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

/**
 * POST /api/v1/waitlist
 * Body: { email, tipo?, empresa?, consent?, website?, source? }
 *   website → honeypot: si viene con contenido, es un bot.
 */
export async function subscribe(req, res) {
  try {
    const { email, tipo, empresa, consent, website, source = {} } = req.body || {};

    // Honeypot: campo oculto que un humano nunca completa. Respondemos 200 para
    // no darle al bot la señal de que fue detectado, pero no persistimos nada.
    if (typeof website === 'string' && website.trim() !== '') {
      logger.info('[waitlist] honeypot activado — registro descartado');
      return res.status(200).json({ ok: true, alreadyRegistered: false });
    }

    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(normalizedEmail) || normalizedEmail.length > 254) {
      return res.status(400).json({ ok: false, error: 'Correo electrónico inválido.' });
    }

    const normalizedTipo = tipo === 'empresa' ? 'empresa' : 'persona';

    const nombreEmpresa = normalizedTipo === 'empresa' ? clean(empresa, 120) : undefined;

    // Intentamos crear y usamos el índice único como detector de duplicado.
    // Se prefiere esto a inspeccionar los metadatos de un upsert porque su
    // forma cambia entre versiones del driver — acá el resultado es explícito.
    let alreadyRegistered = false;
    try {
      await WaitlistEntry.create({
        email: normalizedEmail,
        tipo: normalizedTipo,
        ...(nombreEmpresa ? { empresa: nombreEmpresa } : {}),
        consent: consent !== false,
        // La atribución se fija solo al crear: si alguien vuelve desde otra
        // campaña, el origen que vale es el primero, el que convirtió.
        source: {
          utmSource:   clean(source.utmSource, 100),
          utmMedium:   clean(source.utmMedium, 100),
          utmCampaign: clean(source.utmCampaign, 100),
          utmContent:  clean(source.utmContent, 100),
          referrer:    clean(source.referrer, 300),
          landing:     clean(source.landing, 300),
        },
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;   // duplicado esperado; el resto sube
      alreadyRegistered = true;

      // Ya estaba: actualizamos lo que puede haber cambiado y reactivamos si
      // se había dado de baja. La atribución original queda intacta.
      await WaitlistEntry.updateOne(
        { email: normalizedEmail },
        {
          $set: {
            tipo: normalizedTipo,
            ...(nombreEmpresa ? { empresa: nombreEmpresa } : {}),
            consent: consent !== false,
            unsubscribedAt: null,
          },
        },
      );
    }

    logger.info('[waitlist] alta procesada', {
      tipo: normalizedTipo,
      alreadyRegistered,
      utmSource: clean(source.utmSource, 100) || 'directo',
    });

    return res.status(200).json({ ok: true, alreadyRegistered });
  } catch (err) {
    // Carrera de índice único: dos envíos simultáneos del mismo correo. No es
    // un fallo desde el punto de vista del usuario — ya está en la lista.
    if (err?.code === 11000) {
      return res.status(200).json({ ok: true, alreadyRegistered: true });
    }

    logger.error('[waitlist] alta falló', { error: err.message });
    Sentry.captureException(err, { tags: { controller: 'waitlistController' } });
    return res.status(500).json({ ok: false, error: 'No pudimos registrarte. Intenta de nuevo.' });
  }
}

// ─── Lectura (solo admin) ─────────────────────────────────────────────────────
//
// La lista de espera es el activo del pre-lanzamiento: hay que poder verla,
// segmentarla y exportarla. Ambos endpoints exigen sesión admin.

/**
 * GET /api/v1/waitlist/entries
 * Query: tipo?, utmSource?, desde?, hasta?, page?, limit?
 * Devuelve el resumen agregado + la página de registros.
 */
export async function listEntries(req, res) {
  try {
    const { tipo, utmSource, desde, hasta } = req.query;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));

    const filtro = {};
    if (tipo === 'empresa' || tipo === 'persona') filtro.tipo = tipo;
    if (utmSource) filtro['source.utmSource'] = utmSource;
    if (desde || hasta) {
      filtro.createdAt = {};
      if (desde) filtro.createdAt.$gte = new Date(desde);
      if (hasta) filtro.createdAt.$lte = new Date(hasta);
    }

    const [total, entries, porTipo, porOrigen] = await Promise.all([
      WaitlistEntry.countDocuments(filtro),
      WaitlistEntry.find(filtro)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      // Resumen global (sin filtro): cuántos de cada tipo.
      WaitlistEntry.aggregate([{ $group: { _id: '$tipo', n: { $sum: 1 } } }]),
      // Resumen global por origen — responde "qué canal trae registros".
      WaitlistEntry.aggregate([
        { $group: { _id: { $ifNull: ['$source.utmSource', 'directo'] }, n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]),
    ]);

    return res.status(200).json({
      ok: true,
      resumen: {
        totalGlobal: porTipo.reduce((acc, r) => acc + r.n, 0),
        porTipo:   Object.fromEntries(porTipo.map(r => [r._id || 'persona', r.n])),
        porOrigen: Object.fromEntries(porOrigen.map(r => [r._id, r.n])),
      },
      paginacion: { page, limit, totalFiltrado: total, paginas: Math.ceil(total / limit) },
      entries,
    });
  } catch (err) {
    logger.error('[waitlist] listEntries falló', { error: err.message });
    Sentry.captureException(err, { tags: { controller: 'waitlistController' } });
    return res.status(500).json({ ok: false, error: 'No se pudo obtener la lista.' });
  }
}

// Escapa un valor para CSV: comillas dobles y separadores dentro del texto
// (una razón social con coma rompería el archivo sin esto).
function csvCell(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * GET /api/v1/waitlist/export
 * Descarga la lista completa en CSV. Acepta los mismos filtros que listEntries.
 */
export async function exportCsv(req, res) {
  try {
    const { tipo } = req.query;
    const filtro = {};
    if (tipo === 'empresa' || tipo === 'persona') filtro.tipo = tipo;

    const entries = await WaitlistEntry.find(filtro).sort({ createdAt: -1 }).lean();

    const cabecera = [
      'fecha', 'email', 'tipo', 'empresa',
      'utm_source', 'utm_medium', 'utm_campaign', 'referrer',
      'consentimiento', 'notificado', 'baja',
    ];

    const filas = entries.map(e => [
      e.createdAt?.toISOString() ?? '',
      e.email,
      e.tipo,
      e.empresa ?? '',
      e.source?.utmSource ?? '',
      e.source?.utmMedium ?? '',
      e.source?.utmCampaign ?? '',
      e.source?.referrer ?? '',
      e.consent ? 'si' : 'no',
      e.notifiedAt ? e.notifiedAt.toISOString() : '',
      e.unsubscribedAt ? e.unsubscribedAt.toISOString() : '',
    ].map(csvCell).join(','));

    // BOM inicial para que Excel abra los acentos correctamente.
    const csv = '﻿' + [cabecera.join(','), ...filas].join('\n');

    logger.info('[waitlist] export CSV', { registros: entries.length, tipo: tipo || 'todos' });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="waitlist-alyto-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    logger.error('[waitlist] exportCsv falló', { error: err.message });
    Sentry.captureException(err, { tags: { controller: 'waitlistController' } });
    return res.status(500).json({ ok: false, error: 'No se pudo exportar la lista.' });
  }
}

export default { subscribe, listEntries, exportCsv };
