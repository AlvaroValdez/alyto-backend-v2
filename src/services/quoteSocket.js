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
import { getPrices }       from './vitaWalletService.js';
import Sentry              from './sentry.js';

// ─── Configuración ────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS          = parseInt(process.env.QUOTE_REFRESH_INTERVAL_MS    ?? '60000', 10);
const RATE_CHANGE_THRESHOLD        = parseFloat(process.env.QUOTE_RATE_CHANGE_THRESHOLD ?? '0.005');
const CACHE_REFRESH_BEFORE_EXPIRY  = 2 * 60 * 1000;   // refrescar Vita 2 min antes de que expire
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
    vitaCache.prices  = data;
    vitaCache.fetchedAt = new Date();
    // valid_until puede estar ausente en sandbox — fallback a 10 min
    vitaCache.validUntil = data?.valid_until
      ? new Date(data.valid_until)
      : new Date(Date.now() + 10 * 60 * 1000);
    return true;
  } catch (err) {
    console.warn('[Alyto WS] No se pudo refrescar el cache de precios Vita:', err.message);
    return false;
  }
}

// ─── Cálculo de Cotización ────────────────────────────────────────────────────

/**
 * Extrae la tasa y el costo fijo desde el cache de Vita para el par
 * (originCurrency, destinationCountry). Misma lógica que extractVitaPricing
 * en paymentController — duplicada aquí para evitar acoplamiento servicio↔controlador.
 *
 * @param {string} originCurrency      ISO 4217 mayúsculas (ej. 'CLP')
 * @param {string} destinationCountry  ISO alpha-2 mayúsculas (ej. 'CO')
 * @returns {{ rate: number, fixedCost: number, validUntil: string|null } | null}
 */
function extractPricing(originCurrency, destinationCountry) {
  const withdrawal = vitaCache.prices?.withdrawal;
  if (!withdrawal) return null;

  const priceKey   = `${originCurrency.toLowerCase()}_sell`;
  const countryKey = destinationCountry.toLowerCase();
  const rateRaw    = withdrawal?.prices?.attributes?.[priceKey]?.[countryKey];

  if (rateRaw == null) return null;
  const rate = Number(rateRaw);
  if (!isFinite(rate) || rate <= 0) return null;

  const fixedCost  = Number(withdrawal?.[countryKey]?.fixed_cost ?? 0);
  const validUntil = vitaCache.prices?.valid_until ?? null;

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
  if (isCacheStale()) {
    await refreshVitaCache();
  }

  const { corridor, originAmount, destinationCountry } = state;
  if (!corridor || !originAmount || !destinationCountry) return null;

  const pricing = extractPricing(corridor.originCurrency, destinationCountry);
  if (!pricing) return null;

  const { rate: exchangeRate, fixedCost: vitaFixedCost } = pricing;
  const amount  = Number(originAmount);
  const round2  = n => Math.round(n * 100) / 100;

  // Misma fórmula que getQuote en paymentController.js
  const payinFee        = amount * (corridor.payinFeePercent    / 100);
  const alytoCSpread    = amount * (corridor.alytoCSpread       / 100);
  const fixedFee        = corridor.fixedFee                     ?? 0;
  const profitRetention = amount * (corridor.profitRetentionPercent / 100);
  const totalFees       = payinFee + alytoCSpread + fixedFee;
  const amountAfterFees = amount - totalFees - profitRetention;
  const payoutFee       = vitaFixedCost > 0 ? vitaFixedCost : (corridor.payoutFeeFixed ?? 0);
  const destinationAmount = round2((amountAfterFees * exchangeRate) - payoutFee);

  if (destinationAmount <= 0) return null;

  const localExpiry = new Date(Date.now() + 3 * 60 * 1000);
  const vitaExpiry  = pricing.validUntil ? new Date(pricing.validUntil) : null;
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
      payinFee:      round2(payinFee),
      alytoCSpread:  round2(alytoCSpread),
      fixedFee:      round2(fixedFee),
      payoutFee:     round2(payoutFee),
      totalDeducted: round2(totalFees + payoutFee),
    },
    quoteExpiresAt,
    updatedAt:  new Date(),
    stale:      !vitaCache.prices,  // true si Vita no respondió y estamos usando cache expirado
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
