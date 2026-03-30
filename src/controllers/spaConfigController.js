/**
 * spaConfigController.js — CRUD SpA Chile Config
 *
 * Gestiona datos bancarios AV Finance SpA y tasa CLP/BOB
 * para el corredor manual CL→BO.
 *
 * Endpoints:
 *   GET   /api/v1/admin/spa-config             — Lee config actual
 *   PATCH /api/v1/admin/spa-config             — Actualiza config
 *   GET   /api/v1/payments/spa-payin-instructions — Instrucciones de pago (user)
 */

import SpAConfig from '../models/SpAConfig.js';
import Sentry    from '../services/sentry.js';

// ─── GET /api/v1/admin/spa-config ───────────────────────────────────────────

export async function getSpAConfig(req, res) {
  try {
    let config = await SpAConfig.findOne().sort({ createdAt: -1 }).lean();
    if (!config) config = await SpAConfig.create({});
    return res.status(200).json(config);
  } catch (err) {
    Sentry.captureException(err);
    return res.status(500).json({ error: 'Error al obtener SpAConfig.' });
  }
}

// ─── PATCH /api/v1/admin/spa-config ─────────────────────────────────────────

export async function updateSpAConfig(req, res) {
  try {
    const {
      bankName, accountType, accountNumber, rut,
      accountHolder, bankEmail,
      clpPerBob, clpPerUsdt, usdtPerBob,
      minAmountCLP, maxAmountCLP, isActive,
    } = req.body;

    // Validaciones
    if (clpPerBob !== undefined) {
      if (isNaN(clpPerBob) || Number(clpPerBob) <= 0) {
        return res.status(400).json({
          error: 'clpPerBob debe ser un numero positivo. Ejemplo: 99.59 (1 BOB = 99.59 CLP)',
        });
      }
    }
    if (minAmountCLP !== undefined && maxAmountCLP !== undefined) {
      if (Number(minAmountCLP) >= Number(maxAmountCLP)) {
        return res.status(400).json({
          error: 'minAmountCLP debe ser menor que maxAmountCLP.',
        });
      }
    }

    let config = await SpAConfig.findOne().sort({ createdAt: -1 });
    if (!config) config = new SpAConfig({});

    if (bankName      !== undefined) config.bankName      = bankName;
    if (accountType   !== undefined) config.accountType   = accountType;
    if (accountNumber !== undefined) config.accountNumber = accountNumber;
    if (rut           !== undefined) config.rut           = rut;
    if (accountHolder !== undefined) config.accountHolder = accountHolder;
    if (bankEmail     !== undefined) config.bankEmail     = bankEmail;
    if (clpPerUsdt    !== undefined) config.clpPerUsdt    = Number(clpPerUsdt);
    if (usdtPerBob    !== undefined) config.usdtPerBob    = Number(usdtPerBob);
    if (clpPerBob     !== undefined) config.clpPerBob     = Number(clpPerBob);
    if (minAmountCLP  !== undefined) config.minAmountCLP  = Number(minAmountCLP);
    if (maxAmountCLP  !== undefined) config.maxAmountCLP  = Number(maxAmountCLP);
    if (isActive      !== undefined) config.isActive      = isActive;
    config.updatedBy = req.user._id;

    await config.save();

    console.info('[SpAConfig] Actualizado:', {
      clpPerBob: config.clpPerBob,
      bank:      config.bankName,
      min:       config.minAmountCLP,
      max:       config.maxAmountCLP,
    });

    return res.status(200).json(config);
  } catch (err) {
    Sentry.captureException(err);
    return res.status(500).json({ error: 'Error al actualizar SpAConfig.' });
  }
}

// ─── GET /api/v1/payments/spa-payin-instructions ────────────────────────────

export async function getSpAPayinInstructions(req, res) {
  try {
    const config = await SpAConfig
      .findOne({ isActive: true })
      .select('bankName accountType accountNumber rut accountHolder bankEmail')
      .lean();
    if (!config) {
      return res.status(404).json({ error: 'Instrucciones de pago no disponibles.' });
    }
    return res.status(200).json(config);
  } catch (err) {
    Sentry.captureException(err);
    return res.status(500).json({ error: 'Error al obtener instrucciones de pago.' });
  }
}
