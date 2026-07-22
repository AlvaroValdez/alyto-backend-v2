/**
 * stellar.js — Configuración del SDK de Stellar para Alyto V2.0
 *
 * Exporta una instancia pre-configurada del servidor Horizon y las
 * constantes de red. El resto de los servicios importa desde aquí —
 * nunca instancian Horizon.Server directamente.
 *
 * Red activa: la decide STELLAR_NETWORK por entorno —
 *   Producción (VPS):  STELLAR_NETWORK=mainnet  (activo desde 2026-05-30, hito H3)
 *   Staging (Render):  testnet (default si la variable no está definida)
 *
 * Assets soportados:
 *   ✅ USDC  — Circle (GA5ZSEJYB37...) — activo
 *   ⏸ CLPX  — Anclap — PAUSADO, sin contrato vigente
 *   ⏸ BP Ventures assets — PAUSADOS, sin integración iniciada
 */

import { Horizon, Networks, Asset, Keypair } from '@stellar/stellar-sdk';

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
 * Configurable via STELLAR_PRIORITY_FEE_STROOPS env var.
 * Default: 1000 stroops. Ajustar según congestión de red.
 */
export const PRIORITY_FEE_STROOPS = process.env.STELLAR_PRIORITY_FEE_STROOPS || '1000';

/** Timeout estándar para transacciones (segundos). */
export const TX_TIMEOUT_SECONDS = 30;

// ─── SEP-10 Web Auth — llave de firma dedicada ───────────────────────────────

/**
 * Llave PÚBLICA que se publica como `SIGNING_KEY` en el stellar.toml y con cuya
 * secreta el servidor firma/verifica los challenges SEP-10.
 *
 * Higiene de llaves (best practice SEP-10): la firma de autenticación debe vivir
 * en una cuenta DEDICADA, separada de la tesorería SRL que custodia los USDC.
 * Acoplar ambas obliga a tocar la cuenta con fondos para rotar la firma y expone
 * públicamente cuál es la cuenta operativa.
 *
 * Precedencia (una sola variable controla el switch):
 *   1. STELLAR_SEP10_SECRET_KEY  → se DERIVA la pública de ella. Garantiza que el
 *      `SIGNING_KEY` del toml y el firmante real sean SIEMPRE el mismo: es
 *      imposible desincronizarlos por error de operador. Si está seteada debe ser
 *      válida (falla en boot si no — preferible a servir un toml roto en silencio).
 *   2. STELLAR_SRL_PUBLIC_KEY    → fallback legacy (tesorería = firmante), el
 *      comportamiento previo. Permite migrar en UN solo paso: al setear
 *      STELLAR_SEP10_SECRET_KEY en el env, toml y firmante cambian juntos y
 *      atómicamente en el próximo deploy.
 *
 * ⚠️ No se soporta publicar una pública "suelta" sin su secreta: un SIGNING_KEY
 * cuya secreta el servidor no posee rompe SEP-10 (no podría firmar los challenges).
 * ⚠️ El secreto NUNCA se exporta desde aquí; sep10Service lo resuelve con esta
 * MISMA precedencia para firmar. Este módulo solo expone la pública.
 */
export const SEP10_SIGNING_PUBLIC = process.env.STELLAR_SEP10_SECRET_KEY
  ? Keypair.fromSecret(process.env.STELLAR_SEP10_SECRET_KEY).publicKey()
  : (process.env.STELLAR_SRL_PUBLIC_KEY ?? '');

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
