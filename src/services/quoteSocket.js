/**
 * quoteSocket.js — Servidor WebSocket de Cotizaciones en Tiempo Real
 *
 * Monta un WebSocket server sobre el servidor HTTP existente en /ws/quote.
 * NO crea un nuevo servidor HTTP.
 *
 * Características:
 *   - Cache global de precios Vita compartido entre todas las conexiones
 *   - Refresh automático configurable (QUOTE_REFRESH_INTERVAL_MS, default 60s)
 *   - Detección de cambio de tasa significativo (QUOTE_RATE_CHANGE_THRESHOLD, default 0.5%)
 *   - Validación JWT en el primer mensaje subscribe_quote
 *   - Máximo 3 conexiones simultáneas por userId (anti-abuso multi-tab)
 *   - Limpieza garantizada de timers al desconectar
 *
 * Protocolo de mensajes: ver spec en CLAUDE.md / tarea WS
 *
 * Uso en server.js:
 *   const server = app.listen(PORT, ...)
 *   createQuoteSocketServer(server)
 */

import { WebSocketServer } from 'ws';
import jwt                 from 'jsonwebtoken';
import User                from '../models/User.js';
import TransactionConfig   from '../models/TransactionConfig.js';
import SpAConfig           from '../models/SpAConfig.js';
import { getPrices, VITA_SENT_ONLY_COUNTRIES } from './vitaWalletService.js';
import { getBOBRate }      from './exchangeRateService.js';
import Sentry              from './sentry.js';

// ─── Configuración ────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS          = parseInt(process.env.QUOTE_REFRESH_INTERVAL_MS    ?? '60000', 10);
const RATE_CHANGE_THRESHOLD        = parseFloat(process.env.QUOTE_RATE_CHANGE_THRESHOLD ?? '0.005');
const CACHE_REFRESH_BEFORE_EXPIRY  = parseInt(process.env.QUOTE_CACHE_REFRESH_BEFORE_MS ?? '120000', 10);
const QUOTE_VALIDITY_MS            = parseInt(process.env.QUOTE_VALIDITY_MS             ?? '180000', 10); // 3 min
const VITA_CACHE_DEFAULT_TTL_MS    = parseInt(process.env.VITA_CACHE_TTL_MS             ?? '600000', 10); // 10 min
const MAX_CONNECTIONS_PER_USER     = 3;

// ─── Cache Global de Precios Vita ─────────────────────────────────────────────

/**
 * Único cache compartido entre todas las conexiones WebSocket activas.
 * Evita N llamadas simultáneas a Vita cuando N clientes están conectados.
 *
 * @type {{ prices: object|null, fetchedAt: Date|null, validUntil: Date|null }}
 */
const vitaCache = {
  prices:    null,
  fetchedAt: null,
  validUntil: null,
};

/**
 * Indica si el cache necesita ser refrescado.
 * Se considera stale cuando:
 *   - Nunca se cargó, o
 *   - valid_until de Vita está a menos de 2 min de expirar
 */
function isCacheStale() {
  if (!vitaCache.prices || !vitaCache.validUntil) return true;
  return (vitaCache.validUntil.getTime() - Date.now()) < CACHE_REFRESH_BEFORE_EXPIRY;
}

/**
 * Llama a Vita /prices y actualiza el cache global.
 * Si Vita no responde, mantiene el cache anterior (stale: true).
 *
 * @returns {Promise<boolean>} true si el refresh fue exitoso
 */
async function refreshVitaCache() {
  try {
    const data        = await getPrices();
    vitaCache.prices    = data;
    vitaCache.fetchedAt = new Date();
    // valid_until está en withdrawal.prices.attributes.valid_until (no en raíz)
    const vitaValidUntil = data?.withdrawal?.prices?.attributes?.valid_until;
    vitaCache.validUntil = vitaValidUntil
      ? new Date(vitaValidUntil)
      : new Date(Date.now() + VITA_CACHE_DEFAULT_TTL_MS);
    return true;
  } catch (err) {
    console.warn('[Alyto WS] No se pudo refrescar el cache de precios Vita:', err.message);
    return false;
  }
}

// ─── Cálculo de Cotización ────────────────────────────────────────────────────

/**
 * Extrae tasa CLP→destino desde el cache de Vita.
 * Para USD/USDC origin: cross-rate via CLP.
 *
 * @param {string} originCurrency     'CLP' | 'USD' | 'USDC'
 * @param {string} destinationCountry ISO alpha-2 (ej. 'CO')
 * @returns {{ rate: number, fixedCost: number, validUntil: string|null } | null}
 */
function extractPricing(originCurrency, destinationCountry) {
  const destUpper  = destinationCountry.toUpperCase();
  const attrsSource = VITA_SENT_ONLY_COUNTRIES.has(destUpper)
    ? vitaCache.prices?.vita_sent?.prices?.attributes
    : vitaCache.prices?.withdrawal?.prices?.attributes;
  const attrs = attrsSource ?? vitaCache.prices?.withdrawal?.prices?.attributes;
  if (!attrs) return null;

  const countryKey = destinationCountry.toLowerCase();
  const origin     = originCurrency.toUpperCase();
  let rate;

  if (origin === 'CLP') {
    const raw = attrs?.clp_sell?.[countryKey];
    if (raw == null) return null;
    rate = Number(raw);
  } else if (origin === 'USD' || origin === 'USDC') {
    // Vita no tiene usd_sell — derivamos via cross-rate CLP
    const clpToDest = Number(attrs?.clp_sell?.[countryKey] ?? NaN);
    const clpToUsd  = Number(attrs?.clp_sell?.['us']       ?? NaN);
    if (!isFinite(clpToDest) || !isFinite(clpToUsd) || clpToUsd <= 0) return null;
    rate = clpToDest / clpToUsd;
  } else {
    return null;
  }

  if (!isFinite(rate) || rate <= 0) return null;

  const fixedCost  = Number(attrs?.fixed_cost?.[countryKey] ?? 0);
  const validUntil = attrs?.valid_until ?? null;

  return { rate, fixedCost, validUntil };
}

/**
 * Extrae tasa USD→destino desde el cache de Vita (para corredores BOB).
 * Misma lógica que extractVitaPricing(vitaResponse, 'USD', dest) en paymentController.
 *
 * @param {string} destinationCountry ISO alpha-2 (ej. 'CO')
 * @returns {{ rate: number, fixedCost: number, validUntil: string|null } | null}
 */
function extractPricingUSD(destinationCountry) {
  const destUpper  = destinationCountry.toUpperCase();
  const attrsSource = VITA_SENT_ONLY_COUNTRIES.has(destUpper)
    ? vitaCache.prices?.vita_sent?.prices?.attributes
    : vitaCache.prices?.withdrawal?.prices?.attributes;
  const attrs = attrsSource ?? vitaCache.prices?.withdrawal?.prices?.attributes;
  if (!attrs) return null;

  const countryKey = destinationCountry.toLowerCase();

  const clpToDest = Number(attrs?.clp_sell?.[countryKey] ?? NaN);
  const clpToUsd  = Number(attrs?.clp_sell?.['us']       ?? NaN);
  if (!isFinite(clpToDest) || !isFinite(clpToUsd) || clpToUsd <= 0) return null;

  const rate       = clpToDest / clpToUsd;   // unidades dest por 1 USD
  if (!isFinite(rate) || rate <= 0) return null;

  const fixedCost  = Number(attrs?.fixed_cost?.[countryKey] ?? 0);
  const validUntil = attrs?.valid_until ?? null;

  return { rate, fixedCost, validUntil };
}

/**
 * Calcula la cotización completa a partir del estado de la conexión.
 * Refresca el cache de Vita si está stale antes de calcular.
 *
 * @param {ConnectionState} state
 * @returns {Promise<QuoteUpdateMessage | null>}
 */
async function computeQuote(state) {
  const { corridor, originAmount, destinationCountry } = state;
  if (!corridor || !originAmount || !destinationCountry) return null;

  const amount = Number(originAmount);
  const round2 = n => Math.round(n * 100) / 100;

  // Validar monto mínimo del corredor
  const minAmount = corridor.minAmountOrigin ?? 0;
  if (minAmount > 0 && amount < minAmount) {
    return {
      type:           'quote_error',
      code:           'BELOW_MINIMUM',
      message:        `El monto mínimo para este corredor es ${minAmount} ${corridor.originCurrency}.`,
      minAmountOrigin: minAmount,
      currency:        corridor.originCurrency,
    };
  }

  const payinFee        = round2(amount * (corridor.payinFeePercent        / 100));
  const alytoCSpread    = round2(amount * (corridor.alytoCSpread           / 100));
  const fixedFee        = corridor.fixedFee                                ?? 0;
  const profitRetention = round2(amount * (corridor.profitRetentionPercent / 100));

  // ── BRANCH 1: CLP→BOB con payout anchorBolivia — usa SpAConfig, no Vita ────
  // Cubre: corredor cl-bo (legalEntity:SRL, payinMethod:fintoc, payout:anchorBolivia)
  if (
    corridor.destinationCurrency === 'BOB' &&
    corridor.payoutMethod        === 'anchorBolivia'
  ) {
    const spaCfg = await SpAConfig.findOne({ isActive: true }).sort({ createdAt: -1 }).lean();
    if (!spaCfg?.clpPerBob) {
      console.warn('[Alyto WS] SpAConfig sin clpPerBob — corredor CLP→BOB no disponible');
      return null;
    }

    const { clpPerBob } = spaCfg;
    const totalDeducted     = round2(payinFee + alytoCSpread + fixedFee + profitRetention);
    const netCLP            = round2(amount - totalDeducted);
    const destinationAmount = round2(netCLP / clpPerBob);

    if (destinationAmount <= 0) return null;

    // Tasa efectiva all-in: comisiones absorbidas — el usuario no ve el desglose
    const effectiveRate  = +(destinationAmount / amount).toFixed(6);
    const quoteExpiresAt = new Date(Date.now() + QUOTE_VALIDITY_MS);

    console.info('[Alyto WS] Quote CL-BO (anchorBolivia):', {
      amount, clpPerBob, totalDeducted, netCLP, destinationAmount, effectiveRate,
    });

    return {
      type:                'quote_update',
      corridorId:          corridor.corridorId,
      originAmount:        amount,
      originCurrency:      corridor.originCurrency,
      destinationAmount,
      destinationCurrency: 'BOB',
      exchangeRate:        effectiveRate,
      isManualCorridor:    true,
      fees: {
        payinFee:      round2(payinFee),
        alytoCSpread:  round2(alytoCSpread),
        fixedFee:      round2(fixedFee),
        payoutFee:     0,
        totalDeducted: round2(payinFee + alytoCSpread + fixedFee),
      },
      quoteExpiresAt,
      updatedAt: new Date(),
      stale:     false,
    };
  }

  // ── BRANCH 2: BOB→destino — BOB→USDC→dest vía Vita ──────────────────────────
  // Cubre: bo-co, bo-pe, bo-cl, bo-ar, bo-mx, bo-br, bo-us, bo-eu, etc.
  if (corridor.originCurrency === 'BOB') {
    if (isCacheStale()) await refreshVitaCache();

    // Tasa BOB/USDC: prioridad corridor.manualExchangeRate → MongoDB → env
    const bobPerUsdc = corridor.manualExchangeRate > 0
      ? corridor.manualExchangeRate
      : await getBOBRate();

    // Vita USD→dest (cross-rate via CLP)
    const usdPricing = extractPricingUSD(destinationCountry);
    if (!usdPricing) {
      console.warn('[Alyto WS] Sin tasa USD→' + destinationCountry + ' en Vita para BOB corredor');
      return null;
    }

    const { rate: usdToDestRate, fixedCost: vitaFixedCost, validUntil } = usdPricing;

    const netBOB = round2(amount - payinFee - alytoCSpread - fixedFee - profitRetention);
    if (netBOB <= 0) return null;

    const usdcTransitAmount = round2(netBOB / bobPerUsdc);
    const payoutFee         = vitaFixedCost > 0 ? vitaFixedCost : (corridor.payoutFeeFixed ?? 0);
    // Aplicar markup sobre tasa Vita para proteger a Alyto del drift FX
    const vitaMarkup        = corridor.vitaRateMarkup ?? 0.5;
    const adjustedRate      = round2(usdToDestRate * (1 - vitaMarkup / 100));
    const destinationAmount = round2((usdcTransitAmount * adjustedRate) - payoutFee);

    if (destinationAmount <= 0) return null;

    const effectiveRate  = round2(destinationAmount / amount);
    const localExpiry    = new Date(Date.now() + QUOTE_VALIDITY_MS);
    const vitaExpiry     = validUntil ? new Date(validUntil) : null;
    const quoteExpiresAt = (vitaExpiry && vitaExpiry < localExpiry) ? vitaExpiry : localExpiry;

    console.info('[Alyto WS] Quote BOB→' + destinationCountry + ':', {
      amount, bobPerUsdc, netBOB, usdcTransitAmount, usdToDestRate, destinationAmount, effectiveRate,
    });

    return {
      type:                'quote_update',
      corridorId:          corridor.corridorId,
      originAmount:        amount,
      originCurrency:      'BOB',
      destinationAmount,
      destinationCurrency: corridor.destinationCurrency,
      exchangeRate:        effectiveRate,
      conversionPath:      `BOB → USDC → ${corridor.destinationCurrency}`,
      isManualCorridor:    corridor.payoutMethod === 'anchorBolivia',
      usdcTransitAmount,
      bobPerUsdc,
      fees: {
        payinFee,
        alytoCSpread,
        fixedFee,
        payoutFee:       0,           // vita fixedCost ya descontado de destinationAmount (en moneda destino)
        profitRetention,
        totalDeducted:   round2(payinFee + alytoCSpread + fixedFee + profitRetention),
      },
      quoteExpiresAt,
      updatedAt: new Date(),
      stale:     !vitaCache.prices,
    };
  }

  // ── BRANCH 3: CLP/USD/USDC→destino vía Vita (corredores estándar SpA/LLC) ───
  if (isCacheStale()) await refreshVitaCache();

  const pricing = extractPricing(corridor.originCurrency, destinationCountry);
  if (!pricing) return null;

  const { rate: exchangeRate, fixedCost: vitaFixedCost } = pricing;
  const totalDeducted     = round2(payinFee + alytoCSpread + fixedFee + profitRetention);
  const amountAfterFees   = round2(amount - totalDeducted);
  const payoutFee         = vitaFixedCost > 0 ? vitaFixedCost : (corridor.payoutFeeFixed ?? 0);
  // Aplicar markup sobre tasa Vita para proteger a Alyto del drift FX
  const vitaMarkup        = corridor.vitaRateMarkup ?? 0.5;
  const adjustedRate      = round2(exchangeRate * (1 - vitaMarkup / 100));
  const destinationAmount = round2((amountAfterFees * adjustedRate) - payoutFee);

  if (destinationAmount <= 0) return null;

  const localExpiry    = new Date(Date.now() + QUOTE_VALIDITY_MS);
  const vitaExpiry     = pricing.validUntil ? new Date(pricing.validUntil) : null;
  const quoteExpiresAt = (vitaExpiry && vitaExpiry < localExpiry) ? vitaExpiry : localExpiry;

  return {
    type:                'quote_update',
    corridorId:          corridor.corridorId,
    originAmount:        amount,
    originCurrency:      corridor.originCurrency,
    destinationAmount,
    destinationCurrency: corridor.destinationCurrency,
    exchangeRate,
    fees: {
      payinFee,
      alytoCSpread,
      fixedFee,
      payoutFee:       0,           // vita fixedCost ya descontado de destinationAmount (en moneda destino)
      profitRetention,
      totalDeducted:   round2(totalDeducted),
    },
    quoteExpiresAt,
    updatedAt:  new Date(),
    stale:      !vitaCache.prices,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Envía JSON al cliente solo si la conexión sigue abierta */
function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// ─── Tracking de Conexiones por Usuario ──────────────────────────────────────

/** userId → Set<WebSocket> — limita abuso de múltiples tabs */
const connectionsPerUser = new Map();

function registerConnection(userId, ws) {
  if (!connectionsPerUser.has(userId)) {
    connectionsPerUser.set(userId, new Set());
  }
  connectionsPerUser.get(userId).add(ws);
}

function unregisterConnection(userId, ws) {
  const set = connectionsPerUser.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connectionsPerUser.delete(userId);
}

function connectionCount(userId) {
  return connectionsPerUser.get(userId)?.size ?? 0;
}

// ─── Refresh Automático ───────────────────────────────────────────────────────

/**
 * Programa el siguiente refresh automático para esta conexión.
 * Se cancela en ws.on('close') y se reinicia en 'update_amount' para
 * mantener el ciclo alineado con la actividad del usuario.
 *
 * @param {WebSocket} ws
 */
function scheduleRefresh(ws) {
  const state = ws.quoteState;
  if (state.refreshTimer) clearTimeout(state.refreshTimer);

  state.refreshTimer = setTimeout(async () => {
    if (ws.readyState !== ws.OPEN) return;

    let quote;
    try {
      quote = await computeQuote(state);
    } catch (err) {
      console.error('[Alyto WS] Error computando quote en refresh:', err.message);
    }

    if (!quote) {
      send(ws, {
        type:    'quote_error',
        code:    'VITA_UNAVAILABLE',
        message: 'No se pudo obtener la cotización actualizada. Reintentando en breve.',
      });
      scheduleRefresh(ws);
      return;
    }

    // Detectar cambio de tasa significativo
    if (state.lastRate !== null) {
      const rateChange = Math.abs(quote.exchangeRate - state.lastRate) / state.lastRate;
      if (rateChange >= RATE_CHANGE_THRESHOLD) {
        Sentry.captureMessage('WS quote: cambio de tasa significativo', {
          level: 'info',
          extra: {
            corridorId:     state.corridorId,
            previousRate:   state.lastRate,
            newRate:        quote.exchangeRate,
            changePercent:  `${(rateChange * 100).toFixed(3)}%`,
          },
        });
        console.info('[Alyto WS] Cambio de tasa detectado:', {
          corridorId:   state.corridorId,
          from:         state.lastRate,
          to:           quote.exchangeRate,
          change:       `${(rateChange * 100).toFixed(3)}%`,
        });
      }
    }

    state.lastRate       = quote.exchangeRate;
    state.quoteExpiresAt = quote.quoteExpiresAt;

    send(ws, quote);

    // Notificar si la cotización está próxima a expirar (< 30s)
    const msToExpiry = new Date(quote.quoteExpiresAt).getTime() - Date.now();
    if (msToExpiry < 30_000) {
      send(ws, {
        type:    'quote_expired',
        message: 'Cotización expirada, recalculando...',
      });
    }

    scheduleRefresh(ws);
  }, REFRESH_INTERVAL_MS);
}

// ─── Handlers de Mensajes ─────────────────────────────────────────────────────

/**
 * subscribe_quote: autentica el JWT, encuentra el corredor y envía la primera cotización.
 */
async function handleSubscribe(ws, msg) {
  // ── 1. Validar JWT ────────────────────────────────────────────────────────
  let userId;
  try {
    const decoded = jwt.verify(msg.token, process.env.JWT_SECRET);
    userId = decoded.id;
  } catch {
    ws.close(4001, 'Token inválido o expirado.');
    return;
  }

  // ── 2. Verificar límite de conexiones ─────────────────────────────────────
  if (connectionCount(userId) >= MAX_CONNECTIONS_PER_USER) {
    ws.close(4002, 'Máximo de conexiones simultáneas por usuario alcanzado.');
    return;
  }
  registerConnection(userId, ws);
  ws.quoteState.userId = userId;

  // ── 3. Obtener país de origen desde el perfil del usuario ─────────────────
  let originCountry = 'CL';
  try {
    const user = await User.findById(userId).select('residenceCountry').lean();
    if (user?.residenceCountry) originCountry = user.residenceCountry.toUpperCase();
  } catch { /* no fatal — usar fallback */ }

  // ── 4. Buscar corredor activo ─────────────────────────────────────────────
  const destCountry = (msg.destinationCountry ?? '').toUpperCase();

  let corridor = null;
  try {
    corridor = await TransactionConfig.findOne({
      originCountry:      originCountry,
      destinationCountry: destCountry,
      isActive:           true,
    }).lean();
  } catch (err) {
    console.error('[Alyto WS] Error buscando corredor:', err.message);
  }

  if (!corridor) {
    send(ws, {
      type:    'quote_error',
      code:    'CORRIDOR_NOT_FOUND',
      message: `Corredor no disponible para ${originCountry} → ${destCountry}.`,
    });
    return;
  }

  // ── 5. Actualizar estado de la conexión ───────────────────────────────────
  ws.quoteState.corridorId         = corridor.corridorId;
  ws.quoteState.originAmount       = Number(msg.originAmount);
  ws.quoteState.destinationCountry = destCountry;
  ws.quoteState.corridor           = corridor;

  // ── 6. Enviar cotización inicial (inmediata) ──────────────────────────────
  if (isCacheStale()) await refreshVitaCache();

  const quote = await computeQuote(ws.quoteState);
  if (!quote) {
    send(ws, {
      type:    'quote_error',
      code:    'VITA_UNAVAILABLE',
      message: 'Servicio de tasas temporalmente no disponible.',
    });
  } else {
    ws.quoteState.lastRate       = quote.exchangeRate;
    ws.quoteState.quoteExpiresAt = quote.quoteExpiresAt;
    send(ws, quote);
  }

  // ── 7. Iniciar ciclo de refresh automático ────────────────────────────────
  scheduleRefresh(ws);
}

/**
 * update_amount: el usuario cambió el monto en el Step 1.
 * Recalcula con la tasa en cache (no llama a Vita) y reinicia el timer.
 */
async function handleUpdateAmount(ws, msg) {
  if (!ws.quoteState.userId) {
    send(ws, { type: 'quote_error', code: 'NOT_SUBSCRIBED', message: 'Enviar subscribe_quote primero.' });
    return;
  }

  ws.quoteState.originAmount = Number(msg.originAmount);

  const quote = await computeQuote(ws.quoteState);
  if (!quote) {
    send(ws, { type: 'quote_error', code: 'VITA_UNAVAILABLE', message: 'No se pudo recalcular la cotización.' });
  } else {
    ws.quoteState.lastRate       = quote.exchangeRate;
    ws.quoteState.quoteExpiresAt = quote.quoteExpiresAt;
    send(ws, quote);
  }

  // Reiniciar el ciclo de refresh desde ahora (el usuario está activo)
  scheduleRefresh(ws);
}

// ─── Factory Principal ────────────────────────────────────────────────────────

/**
 * Monta el servidor WebSocket sobre el servidor HTTP existente.
 * Solo debe llamarse una vez, después de crear el httpServer.
 *
 * @param {import('http').Server} httpServer
 * @returns {WebSocketServer}
 */
export function createQuoteSocketServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/quote' });

  wss.on('connection', (ws) => {
    // Estado inicial de la conexión
    ws.quoteState = {
      userId:             null,
      corridorId:         null,
      originAmount:       null,
      destinationCountry: null,
      corridor:           null,
      lastRate:           null,
      quoteExpiresAt:     null,
      refreshTimer:       null,
    };

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'quote_error', code: 'INVALID_MESSAGE', message: 'El mensaje debe ser JSON válido.' });
        return;
      }

      if (!msg?.type) {
        send(ws, { type: 'quote_error', code: 'MISSING_TYPE', message: 'El campo "type" es requerido.' });
        return;
      }

      switch (msg.type) {
        case 'subscribe_quote':
          await handleSubscribe(ws, msg);
          break;

        case 'update_amount':
          await handleUpdateAmount(ws, msg);
          break;

        case 'unsubscribe':
          if (ws.quoteState.refreshTimer) {
            clearTimeout(ws.quoteState.refreshTimer);
            ws.quoteState.refreshTimer = null;
          }
          ws.close(1000, 'Unsubscribed.');
          break;

        default:
          send(ws, {
            type:    'quote_error',
            code:    'UNKNOWN_MESSAGE_TYPE',
            message: `Tipo de mensaje desconocido: ${msg.type}`,
          });
      }
    });

    ws.on('close', () => {
      const state = ws.quoteState;
      if (state.refreshTimer) clearTimeout(state.refreshTimer);
      if (state.userId) unregisterConnection(state.userId, ws);
    });

    ws.on('error', (err) => {
      // Ignorar ECONNRESET y errores de red esperados — solo loguear los inesperados
      if (err.code !== 'ECONNRESET') {
        console.error('[Alyto WS] Error en conexión:', err.message);
      }
    });
  });

  console.info('[Alyto WS] WebSocket server activo en /ws/quote');
  return wss;
}
