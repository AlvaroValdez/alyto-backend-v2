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

// ─── GET /api/v1/admin/exchange-rates/clp-bob ───────────────────────────────

/**
 * Retorna las tres tasas del corredor CLP→BOB:
 *   CLP-USDT  — CLP por 1 USDT (ej. 927.17)
 *   USDT-BOB  — USDT por 1 BOB  (ej. inverso de 9.31 → stored as BOB per USDT, so we use BOB-USDT)
 *   CLP-BOB   — CLP por 1 BOB  (calculada = CLP-USDT / BOB-USDT)
 *
 * Nota: En la DB el par BOB-USDT almacena "BOB por 1 USDT" (ej. 9.31).
 *       clpPerBob = clpPerUsdt / bobPerUsdt
 */
export async function getCLPBOBRate(req, res) {
  try {
    const records = await ExchangeRate.find({
      pair: { $in: ['CLP-USDT', 'BOB-USDT', 'CLP-BOB'] },
    }).lean();

    const byPair = {};
    for (const r of records) byPair[r.pair] = r;

    const clpPerUsdt = byPair['CLP-USDT']?.rate ?? null;
    const bobPerUsdt = byPair['BOB-USDT']?.rate ?? parseFloat(process.env.BOB_USD_RATE ?? '9.31');
    const clpPerBob  = byPair['CLP-BOB']?.rate ?? (clpPerUsdt && bobPerUsdt ? +(clpPerUsdt / bobPerUsdt).toFixed(4) : null);

    return res.status(200).json({
      clpPerUsdt,
      bobPerUsdt,
      clpPerBob,
      pairs: {
        'CLP-USDT': byPair['CLP-USDT'] ?? null,
        'BOB-USDT': byPair['BOB-USDT'] ?? null,
        'CLP-BOB':  byPair['CLP-BOB']  ?? null,
      },
    });
  } catch (err) {
    console.error('[ExchangeRate] Error getCLPBOBRate:', err);
    return res.status(500).json({ error: 'Error interno al obtener tasas CLP-BOB.' });
  }
}

// ─── PATCH /api/v1/admin/exchange-rates/clp-bob ─────────────────────────────

/**
 * Actualiza atómicamente CLP-USDT y BOB-USDT, calcula CLP-BOB,
 * y sincroniza SpAConfig.clpPerBob.
 *
 * Body:
 *   clpPerUsdt {number} — CLP por 1 USDT (ej. 927.17)
 *   bobPerUsdt {number} — BOB por 1 USDT (ej. 9.31)
 *   note       {string} — nota de auditoría (opcional)
 */
export async function updateCLPBOBRate(req, res) {
  try {
    const { clpPerUsdt, bobPerUsdt, note } = req.body;

    if (!clpPerUsdt || !bobPerUsdt) {
      return res.status(400).json({ error: 'Se requiere clpPerUsdt y bobPerUsdt.' });
    }
    if (clpPerUsdt <= 0 || bobPerUsdt <= 0) {
      return res.status(400).json({ error: 'Las tasas deben ser mayores a 0.' });
    }

    const clpPerBob = +(clpPerUsdt / bobPerUsdt).toFixed(4);
    const adminId = req.user._id;

    // Upsert the three pairs atomically
    const upsertPair = async (pair, rate, source) => {
      const existing = await ExchangeRate.findOne({ pair });
      return ExchangeRate.findOneAndUpdate(
        { pair },
        {
          $set: {
            rate,
            previousRate: existing?.rate ?? null,
            source,
            note: note || `Actualización CLP→BOB batch`,
            updatedBy: adminId,
          },
        },
        { upsert: true, new: true, runValidators: true },
      );
    };

    const [clpUsdtDoc, bobUsdtDoc, clpBobDoc] = await Promise.all([
      upsertPair('CLP-USDT', clpPerUsdt, 'binance_p2p'),
      upsertPair('BOB-USDT', bobPerUsdt, 'binance_p2p'),
      upsertPair('CLP-BOB',  clpPerBob,  'calculated'),
    ]);

    // Sync SpAConfig.clpPerBob
    const { default: SpAConfig } = await import('../models/SpAConfig.js');
    let spaConfig = await SpAConfig.findOne().sort({ createdAt: -1 });
    if (spaConfig) {
      spaConfig.clpPerBob = clpPerBob;
      spaConfig.updatedBy = adminId;
      await spaConfig.save();
      console.info(`[ExchangeRate] SpAConfig.clpPerBob sincronizado → ${clpPerBob}`);
    }

    console.info(
      `[ExchangeRate] CLP-BOB batch actualizado por ${req.user.email}: ` +
      `CLP/USDT=${clpPerUsdt}, BOB/USDT=${bobPerUsdt}, CLP/BOB=${clpPerBob}`,
    );

    return res.status(200).json({
      success: true,
      clpPerUsdt: clpUsdtDoc.rate,
      bobPerUsdt: bobUsdtDoc.rate,
      clpPerBob:  clpBobDoc.rate,
      spaConfigSynced: !!spaConfig,
    });
  } catch (err) {
    console.error('[ExchangeRate] Error updateCLPBOBRate:', err);
    return res.status(500).json({ error: 'Error interno al actualizar tasas CLP-BOB.' });
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
