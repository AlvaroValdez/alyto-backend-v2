/**
 * exchangeRateController.js — Gestión de Tasas de Cambio
 *
 * POST /api/v1/admin/exchange-rates  — Crear/actualizar tasa (admin)
 * GET  /api/v1/admin/exchange-rates  — Listar todas las tasas (admin)
 * GET  /api/v1/payments/exchange-rates/:pair — Tasa pública para el frontend
 */

import ExchangeRate from '../models/ExchangeRate.js';

// ─── POST /api/v1/admin/exchange-rates ───────────────────────────────────────

/**
 * Crea o actualiza la tasa de cambio para un par de monedas.
 * Usa upsert: si el par ya existe, guarda previousRate y actualiza.
 *
 * Body:
 *   pair   {String}  — "BOB-USDT" | "BOB-USD" | "CLP-USD" (se normaliza a uppercase)
 *   rate   {Number}  — tasa nueva (unidades de origen por 1 de destino, ej. 9.31)
 *   source {String}  — "manual" | "binance_p2p" | "api"
 *   note   {String}  — descripción del ajuste
 */
export async function upsertExchangeRate(req, res) {
  try {
    const { pair, rate, source = 'manual', note } = req.body;

    if (!pair || rate == null) {
      return res.status(400).json({ error: 'Faltan campos requeridos: pair, rate' });
    }

    if (rate <= 0) {
      return res.status(400).json({ error: 'rate debe ser mayor a 0' });
    }

    const normalizedPair = pair.trim().toUpperCase();

    // Leer tasa actual para guardar en previousRate
    const existing = await ExchangeRate.findOne({ pair: normalizedPair });
    const previousRate = existing?.rate ?? null;

    const updated = await ExchangeRate.findOneAndUpdate(
      { pair: normalizedPair },
      {
        $set: {
          rate,
          previousRate,
          source,
          note,
          updatedBy: req.user._id,
        },
      },
      { upsert: true, new: true, runValidators: true },
    );

    const isNew = previousRate === null;
    console.log(
      `[ExchangeRate] ${isNew ? 'CREADA' : 'ACTUALIZADA'} — ${normalizedPair}: ` +
      `${previousRate ?? '-'} → ${rate} (${source}) por ${req.user.email}`,
    );

    return res.status(200).json({
      success:      true,
      pair:         updated.pair,
      rate:         updated.rate,
      previousRate: updated.previousRate,
      source:       updated.source,
      note:         updated.note,
      updatedAt:    updated.updatedAt,
    });
  } catch (err) {
    console.error('[ExchangeRate] Error al upsert:', err);
    return res.status(500).json({ error: 'Error interno al actualizar tasa' });
  }
}

// ─── GET /api/v1/admin/exchange-rates ────────────────────────────────────────

/**
 * Lista todas las tasas activas (admin).
 * Retorna un array ordenado por par.
 */
export async function listExchangeRates(req, res) {
  try {
    const rates = await ExchangeRate.find({})
      .sort({ pair: 1 })
      .populate('updatedBy', 'name email');

    return res.status(200).json({ rates });
  } catch (err) {
    console.error('[ExchangeRate] Error al listar:', err);
    return res.status(500).json({ error: 'Error interno al listar tasas' });
  }
}

// ─── GET /api/v1/payments/exchange-rates/:pair ───────────────────────────────

/**
 * Retorna la tasa actual para un par específico (endpoint público, sin auth).
 * Fallback a variables de entorno si el par no existe en MongoDB.
 *
 * Params:
 *   pair — "BOB-USDT", "BOB-USD", "CLP-USD"
 */
export async function getPublicExchangeRate(req, res) {
  try {
    const pair = req.params.pair?.trim().toUpperCase();

    if (!pair) {
      return res.status(400).json({ error: 'Parámetro pair requerido' });
    }

    const record = await ExchangeRate.findOne({ pair })
      .select('pair rate source updatedAt');

    if (record) {
      return res.status(200).json({
        pair:      record.pair,
        rate:      record.rate,
        source:    record.source,
        updatedAt: record.updatedAt,
        fromDB:    true,
      });
    }

    // Fallback a .env para pares conocidos
    const fallbacks = {
      'BOB-USDT': parseFloat(process.env.BOB_USD_RATE ?? '9.31'),
      'BOB-USD':  parseFloat(process.env.BOB_USD_RATE ?? '9.31'),
      'CLP-USD':  parseFloat(process.env.CLP_USD_RATE ?? '966'),
    };

    if (fallbacks[pair] !== undefined) {
      return res.status(200).json({
        pair,
        rate:   fallbacks[pair],
        source: 'env_fallback',
        fromDB: false,
      });
    }

    return res.status(404).json({ error: `Tasa no encontrada para el par: ${pair}` });
  } catch (err) {
    console.error('[ExchangeRate] Error al obtener tasa pública:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
}
