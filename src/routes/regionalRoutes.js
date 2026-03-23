/**
 * regionalRoutes.js — Rutas Vita Wallet (Corredor LatAm / Escenario D)
 *
 * Expone los servicios de Vita Wallet para el frontend:
 *   GET  /withdrawal-rules          → Reglas de formulario dinámico por país
 *   GET  /payment-methods/:country  → Métodos de cobro por país (payin)
 *   POST /payout                    → Crear retiro bancario (off-ramp)
 *   POST /payin                     → Crear orden de cobro (on-ramp)
 *
 * Todas las rutas requieren JWT válido (protect).
 * El payout también exige que el usuario tenga KYC aprobado.
 */

import { Router } from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import {
  getWithdrawalRules,
  getPaymentMethods,
  createPayout,
  createPayin,
  getPrices,
} from '../services/vitaWalletService.js';

const router = Router();

// ─── GET /withdrawal-rules ────────────────────────────────────────────────────

/**
 * Retorna los campos dinámicos del formulario de retiro para todos los países.
 * El frontend itera sobre el array y renderiza los inputs según el país seleccionado.
 *
 * GET /api/v1/regional/withdrawal-rules
 * Auth: Bearer JWT
 */
router.get('/withdrawal-rules', protect, async (req, res) => {
  try {
    const rules = await getWithdrawalRules();
    return res.json({ rules });
  } catch (err) {
    console.error('[RegionalRoutes] withdrawal-rules error:', err.message);
    return res.status(err.status ?? 502).json({
      error:    err.message,
      vitaCode: err.vitaCode ?? null,
    });
  }
});

// ─── GET /payment-methods/:countryIso ─────────────────────────────────────────

/**
 * Retorna los métodos de pago disponibles para el país especificado.
 * Cada método incluye los campos requeridos para el pago directo (sin redirección).
 *
 * GET /api/v1/regional/payment-methods/CO
 * Auth: Bearer JWT
 *
 * Países soportados: AR, CL, CO, MX, BR
 */
router.get('/payment-methods/:countryIso', protect, async (req, res) => {
  const { countryIso } = req.params;

  const SUPPORTED = new Set(['AR', 'CL', 'CO', 'MX', 'BR']);
  if (!SUPPORTED.has(countryIso?.toUpperCase())) {
    return res.status(400).json({
      error: `País no soportado para pay-in. Usar: ${[...SUPPORTED].join(', ')}`,
    });
  }

  try {
    const methods = await getPaymentMethods(countryIso);
    return res.json({ methods, country: countryIso.toUpperCase() });
  } catch (err) {
    console.error('[RegionalRoutes] payment-methods error:', err.message);
    return res.status(err.status ?? 502).json({
      error:    err.message,
      vitaCode: err.vitaCode ?? null,
    });
  }
});

// ─── POST /payout ─────────────────────────────────────────────────────────────

/**
 * Crea un retiro bancario (off-ramp) hacia la cuenta del beneficiario.
 * Escenario D del Multi-Entity Router: LatAm General vía Vita Wallet.
 *
 * POST /api/v1/regional/payout
 * Auth: Bearer JWT
 *
 * Body: { country, currency, amount, order, beneficiary_*, [campos_dinámicos_país] }
 */
router.post('/payout', protect, async (req, res) => {
  // Validar KYC aprobado antes de permitir un payout real
  if (req.user.kycStatus !== 'approved') {
    return res.status(403).json({
      error: 'KYC requerido. Completa la verificación de identidad antes de retirar fondos.',
      kycStatus: req.user.kycStatus,
    });
  }

  const {
    country,
    currency,
    amount,
    order,
    beneficiary_first_name,
    beneficiary_last_name,
    beneficiary_email,
    beneficiary_address,
    beneficiary_document_type,
    beneficiary_document_number,
    purpose,
    ...dynamicFields
  } = req.body;

  // Validación de campos obligatorios fijos
  const required = { country, currency, amount, order, beneficiary_first_name, beneficiary_last_name, purpose };
  const missing  = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    return res.status(400).json({ error: `Campos requeridos faltantes: ${missing.join(', ')}` });
  }

  try {
    const result = await createPayout({
      country:                     country.toUpperCase(),
      currency:                    currency.toLowerCase(),
      amount,
      order,
      beneficiary_first_name,
      beneficiary_last_name,
      beneficiary_email,
      beneficiary_address,
      beneficiary_document_type,
      beneficiary_document_number,
      purpose,
      ...dynamicFields,
    });

    console.info(`[RegionalRoutes] Payout creado — userId: ${req.user._id} | país: ${country} | monto: ${amount} ${currency} | order: ${order}`);

    return res.status(201).json({
      message:       'Payout iniciado exitosamente.',
      transaction:   result,
      operatingEntity: 'LLC',
      scenario:        'D',
    });
  } catch (err) {
    console.error('[RegionalRoutes] payout error:', err.message, err.data);
    return res.status(err.status ?? 502).json({
      error:    err.message,
      vitaCode: err.vitaCode ?? null,
      detail:   err.data ?? null,
    });
  }
});

// ─── POST /payin ──────────────────────────────────────────────────────────────

/**
 * Crea una orden de cobro (on-ramp / pay-in) en la moneda local del cliente.
 * El cliente paga en su país; AV Finance recibe en USD/CLP.
 *
 * POST /api/v1/regional/payin
 * Auth: Bearer JWT
 *
 * Body: { amount, country_iso_code, issue, currency_destiny?, is_receive? }
 */
router.post('/payin', protect, async (req, res) => {
  const { amount, country_iso_code, issue } = req.body;

  if (!amount || !country_iso_code || !issue) {
    return res.status(400).json({
      error: 'Los campos amount, country_iso_code e issue son requeridos.',
    });
  }

  // CL excluido: usa Fintoc directo de AV Finance SpA (Escenario B, sin comisión Vita)
  const SUPPORTED_PAYIN = new Set(['AR', 'BR', 'CO', 'MX']);
  if (!SUPPORTED_PAYIN.has(country_iso_code?.toUpperCase())) {
    return res.status(400).json({
      error: `País no soportado para pay-in vía Vita. Usar: ${[...SUPPORTED_PAYIN].join(', ')}. Para Chile usar el flujo Fintoc SpA (/payments/payin/fintoc).`,
    });
  }

  try {
    const payload = {
      amount,
      country_iso_code: country_iso_code.toUpperCase(),
      issue,
      ...(req.body.currency_destiny  ? { currency_destiny:      req.body.currency_destiny  } : {}),
      ...(req.body.is_receive != null ? { is_receive:            req.body.is_receive         } : {}),
      ...(req.body.success_redirect_url ? { success_redirect_url: req.body.success_redirect_url } : {}),
    };

    const result = await createPayin(payload);

    console.info(`[RegionalRoutes] Pay-in creado — userId: ${req.user._id} | país: ${country_iso_code} | monto: ${amount}`);

    return res.status(201).json({
      message:     'Orden de pago creada exitosamente.',
      paymentOrder: result,
    });
  } catch (err) {
    console.error('[RegionalRoutes] payin error:', err.message, err.data);
    return res.status(err.status ?? 502).json({
      error:    err.message,
      vitaCode: err.vitaCode ?? null,
      detail:   err.data ?? null,
    });
  }
});

// ─── GET /prices ──────────────────────────────────────────────────────────────

/**
 * Precios en tiempo real para calcular el monto final a cobrar/pagar.
 * GET /api/v1/regional/prices
 * Auth: Bearer JWT
 */
router.get('/prices', protect, async (req, res) => {
  try {
    const prices = await getPrices();
    return res.json({ prices });
  } catch (err) {
    console.error('[RegionalRoutes] prices error:', err.message);
    return res.status(err.status ?? 502).json({ error: err.message });
  }
});

export default router;
