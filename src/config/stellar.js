/**
 * stellar.js — Configuración del SDK de Stellar para Alyto V2.0
 *
 * Exporta una instancia pre-configurada del servidor Horizon y las
 * constantes de red. El resto de los servicios importa desde aquí —
 * nunca instancian Horizon.Server directamente.
 *
 * Red activa: TESTNET (cambiar STELLAR_NETWORK=mainnet para producción)
 *
 * Assets soportados:
 *   ✅ USDC  — Circle (GA5ZSEJYB37...) — activo
 *   ⏸ CLPX  — Anclap — PAUSADO, sin contrato vigente
 *   ⏸ BP Ventures assets — PAUSADOS, sin integración iniciada
 */

import { Horizon, Networks, Asset } from '@stellar/stellar-sdk';

// ─── Selección de red ────────────────────────────────────────────────────────

const IS_MAINNET = process.env.STELLAR_NETWORK === 'mainnet';

/**
 * Passfrase de red activa.
 * Testnet:  'Test SDF Network ; September 2015'
 * Mainnet:  'Public Global Stellar Network ; September 2015'
 */
export const NETWORK_PASSPHRASE = IS_MAINNET
  ? Networks.PUBLIC
  : Networks.TESTNET;

/**
 * URL del servidor Horizon.
 * Requiere STELLAR_HORIZON_URL en .env.
 * Defaults seguros por entorno si la variable no está definida:
 */
const HORIZON_URL = process.env.STELLAR_HORIZON_URL
  ?? (IS_MAINNET
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org');

// ─── Instancia de Horizon Server ─────────────────────────────────────────────

/**
 * Instancia única del cliente Horizon.
 * Importar esta constante en todos los servicios Stellar.
 * @type {Horizon.Server}
 */
export const horizonServer = new Horizon.Server(HORIZON_URL);

// ─── Constantes de Assets activos ────────────────────────────────────────────

/**
 * USD Coin (USDC) — Circle — ✅ Activo en Mainnet y Testnet.
 *
 * MAINNET issuer:  GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
 * TESTNET issuer:  GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 (Circle Testnet)
 *
 * Referencia: https://www.centre.io/usdc-stellar
 */
export const ASSETS = {
  USDC: new Asset(
    'USDC',
    IS_MAINNET
      ? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
      : 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  ),
  // CLPX: ⏸ PAUSADO — Anclap, sin contrato vigente. No instanciar hasta aviso del equipo.
  // BP_VENTURES: ⏸ PAUSADO — sin integración iniciada.
};

// ─── Constantes de red ───────────────────────────────────────────────────────

/**
 * Base fee en stroops (1 XLM = 10,000,000 stroops).
 * 100 stroops = fee mínima de red (~$0.000001 USD).
 * La Fee Bump puede multiplicar esto para priorización en red congestionada.
 */
export const BASE_FEE_STROOPS = '100';

/**
 * Fee elevada para transacciones con urgencia (Fee Bump corporativo).
 * Ajustar dinámicamente consultando /fee_stats de Horizon en producción.
 */
export const PRIORITY_FEE_STROOPS = '1000';

/** Timeout estándar para transacciones (segundos). */
export const TX_TIMEOUT_SECONDS = 30;

// ─── Info de red activa (útil para logs y debugging) ─────────────────────────

export const NETWORK_INFO = {
  name:       IS_MAINNET ? 'mainnet' : 'testnet',
  horizonUrl: HORIZON_URL,
  passphrase: NETWORK_PASSPHRASE,
};

// Log de arranque — solo keys públicas, nunca secrets
console.info('[Alyto Stellar] SDK configurado:', {
  network:    NETWORK_INFO.name,
  horizonUrl: NETWORK_INFO.horizonUrl,
});
