/**
 * refreshExchangeRates.js — Job de actualización automática de tasas
 *
 * Consulta Binance P2P cada 30 min y actualiza MongoDB ExchangeRate:
 *   - BOB-USDT: mediana de mercado, source='binance_p2p_auto'
 *   - BOB-USDC: BOB-USDT × (1 + spread%), source='binance_p2p_auto'
 *     Solo actualiza BOB-USDC si el documento existente NO tiene source='manual'
 *     (preserva overrides manuales del admin).
 *   - CLP-USDT: mediana de mercado del lado chileno
 *   - CLP-BOB:  derivada = CLP-USDT / BOB-USDT
 *
 * ── Por qué se agregó el lado chileno
 *
 * La tasa del corredor CL→BO vivía en `SpAConfig.clpPerBob`, cargada a mano. Se
 * fijó correctamente en mayo de 2026 y nadie la volvió a tocar; cuando Bolivia
 * pasó a flotación administrada, el boliviano se movió un 24% y la tasa quedó
 * 14% por encima de la real. El efecto habría sido entregarle al beneficiario un
 * 12% menos de bolivianos, con esa diferencia quedando como margen no declarado
 * —justo lo que la regla 11 prohíbe—. No afectó a nadie porque el corredor no
 * tuvo operaciones, pero el defecto no era el número: era que nada lo vigilaba.
 *
 * Derivarla de dos tasas vivas de la MISMA fuente evita además mezclar un precio
 * de mercado con uno de referencia.
 *
 * Triggers:
 *   - setInterval en server.js cada 30 min (primera corrida 90s post-start)
 */

import ExchangeRate           from '../models/ExchangeRate.js';
import SpAConfig              from '../models/SpAConfig.js';
import { fetchFiatUSDTRate }  from '../services/binanceP2PService.js';
import { resolveConvertSpreadPct } from '../services/exchangeRateService.js';

const round6 = n => Math.round(n * 1e6) / 1e6;
const round4 = n => Math.round(n * 1e4) / 1e4;

/**
 * Cuánto puede moverse una tasa entre corridas antes de que sea más probable un
 * error de la fuente que un movimiento real del mercado. Un salto mayor no se
 * publica: preferimos quedarnos con la tasa anterior y avisar, antes que cotizar
 * con un dato absurdo. El boliviano se movió 24% en TRES MESES, así que un 25%
 * en 30 minutos no es mercado.
 */
const SALTO_MAXIMO_PCT = 25;

/**
 * Escribe una tasa, salvo que el salto respecto de la anterior sea implausible.
 * @returns {Promise<boolean>} false si se rechazó por salto
 */
async function publicarTasa(pair, rate, source) {
  const previa = await ExchangeRate.findOne({ pair }).lean();

  if (previa?.rate > 0) {
    const saltoPct = Math.abs(rate - previa.rate) / previa.rate * 100;
    if (saltoPct > SALTO_MAXIMO_PCT) {
      console.error(`[RefreshRates] ⚠️ ${pair}: salto de ${saltoPct.toFixed(1)}% ` +
        `(${previa.rate} → ${rate}) — NO se publica. Revisar la fuente.`);
      return false;
    }
  }

  const r = await ExchangeRate.findOneAndUpdate(
    { pair },
    { $set: { rate, source, updatedAt: new Date() } },
    { upsert: true, returnDocument: 'after' },
  );
  console.log(`[RefreshRates] ${pair} actualizado:`, r.rate, '| source:', r.source);
  return true;
}

export async function refreshExchangeRates() {
  console.log('[RefreshRates] Iniciando actualización de tasa BOB/USDT desde Binance P2P…');

  let rate;
  try {
    rate = await fetchFiatUSDTRate('BOB');
  } catch (err) {
    console.warn('[RefreshRates] No se pudo obtener tasa live de Binance P2P:', err.message);
    return;
  }

  // ── BOB-USDT ─────────────────────────────────────────────────────────────────
  try {
    await publicarTasa('BOB-USDT', rate, 'binance_p2p_auto');
  } catch (err) {
    console.error('[RefreshRates] Error actualizando BOB-USDT en MongoDB:', err.message);
  }

  // ── BOB-USDC (derivada = BOB-USDT × (1 + spread%)) ───────────────────────────
  // Solo actualiza si no hay un override manual del admin. Los overrides manuales
  // tienen source='manual' y deben permanecer intactos hasta que el admin los borre.
  try {
    const existing = await ExchangeRate.findOne({ pair: 'BOB-USDC' }).lean();
    if (existing?.source === 'manual') {
      console.log('[RefreshRates] BOB-USDC tiene override manual (', existing.rate,
        ') — no se sobreescribe');
    } else {
      // Lado compra (BOB→USDC) — mismo spread que getBOBUSDCRateDetailed (admin/env).
      const spreadPct     = await resolveConvertSpreadPct('buy');
      const derivedBOBUSDC = round6(rate * (1 + spreadPct / 100));

      await publicarTasa('BOB-USDC', derivedBOBUSDC, 'binance_p2p_auto');
      console.log('[RefreshRates] BOB-USDC derivado | spread:', spreadPct + '%', '| market:', rate);
    }
  } catch (err) {
    console.error('[RefreshRates] Error actualizando BOB-USDC en MongoDB:', err.message);
  }

  // ── Lado chileno: CLP-USDT y la derivada CLP-BOB ─────────────────────────────
  let clpRate;
  try {
    clpRate = await fetchFiatUSDTRate('CLP');
  } catch (err) {
    // El lado boliviano ya se actualizó; que falle Chile no invalida eso.
    console.warn('[RefreshRates] No se pudo obtener CLP/USDT:', err.message);
    return;
  }

  try {
    await publicarTasa('CLP-USDT', clpRate, 'binance_p2p_auto');
  } catch (err) {
    console.error('[RefreshRates] Error actualizando CLP-USDT:', err.message);
  }

  // CLP por 1 BOB. Las dos puntas salen de la misma fuente y de la misma corrida,
  // así que la división no mezcla precios de momentos distintos.
  const clpPerBob = round4(clpRate / rate);

  try {
    await publicarTasa('CLP-BOB', clpPerBob, 'calculated');
  } catch (err) {
    console.error('[RefreshRates] Error actualizando CLP-BOB:', err.message);
  }

  // ── Sincronizar la tasa que realmente cotiza el corredor ─────────────────────
  // `SpAConfig.clpPerBob` es la que usa `paymentController` para CL→BO. Mientras
  // siga siendo un campo que alguien carga a mano, se vuelve a desactualizar;
  // acá se mantiene al día sola. Se respeta un override manual del admin, igual
  // que con BOB-USDC.
  try {
    const cfg = await SpAConfig.findOne({}).lean();
    if (!cfg) {
      console.log('[RefreshRates] Sin SpAConfig — nada que sincronizar');
    } else if (cfg.rateSource === 'manual') {
      console.log('[RefreshRates] SpAConfig.clpPerBob tiene override manual (',
        cfg.clpPerBob, ') — no se sobreescribe');
    } else {
      const anterior = cfg.clpPerBob;
      await SpAConfig.updateOne({ _id: cfg._id }, {
        $set: { clpPerBob, rateSource: 'binance_p2p_auto', rateUpdatedAt: new Date() },
      });
      console.log('[RefreshRates] SpAConfig.clpPerBob sincronizado:', anterior, '→', clpPerBob);
    }
  } catch (err) {
    console.error('[RefreshRates] Error sincronizando SpAConfig.clpPerBob:', err.message);
  }
}
