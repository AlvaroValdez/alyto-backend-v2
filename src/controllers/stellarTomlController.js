/**
 * stellarTomlController.js — SEP-1 stellar.toml (generado dinámicamente)
 *
 * Renderiza el stellar.toml desde variables de entorno + config de red, de modo
 * que CADA entorno sirva su propia versión correcta SIN archivos estáticos que
 * puedan quedar desincronizados o filtrar URLs de otro entorno:
 *
 *   - Producción (VPS, mainnet):  HOME_DOMAIN=alyto.app
 *                                 STELLAR_ANCHOR_BASE_URL=https://api.alyto.app
 *                                 issuer USDC mainnet, NETWORK_PASSPHRASE público
 *   - Staging (Render, testnet):  HOME_DOMAIN=staging.alyto.app
 *                                 STELLAR_ANCHOR_BASE_URL=https://api-staging.alyto.app
 *                                 issuer USDC testnet, NETWORK_PASSPHRASE testnet
 *
 * El issuer USDC y el NETWORK_PASSPHRASE salen de config/stellar.js, que ya
 * distingue mainnet/testnet por STELLAR_NETWORK. El SIGNING_KEY y las cuentas
 * salen de las env keys públicas (seguras para exponer).
 */

import { ASSETS, NETWORK_PASSPHRASE, NETWORK_INFO } from '../config/stellar.js';

/**
 * GET /.well-known/stellar.toml
 * Sirve el descriptor SEP-1 con Content-Type text/plain + CORS abierto
 * (requerido por wallets que corren en navegador).
 */
export function renderStellarToml(req, res) {
  const homeDomain = process.env.HOME_DOMAIN ?? 'alyto.app';
  const baseUrl    = process.env.STELLAR_ANCHOR_BASE_URL ?? `https://api.${homeDomain}`;

  const signingKey = process.env.STELLAR_SRL_PUBLIC_KEY ?? '';
  const channelKey = process.env.STELLAR_MASTER_PUBLIC ?? '';
  const usdcIssuer = ASSETS.USDC.getIssuer();

  // Cuentas a publicar — solo las que existan (público, seguro)
  const accounts = [signingKey, channelKey].filter(Boolean)
    .map(k => `  "${k}",`).join('\n');

  const toml = `# ─────────────────────────────────────────────────────────────────────────────
# stellar.toml — AV Finance SRL (Alyto) — generado dinámicamente
#
# Entorno: ${NETWORK_INFO.name} · Home domain: ${homeDomain}
# Regulación: DS 5384 (07/05/2025) — ETF / Proveedor de Servicios de Activos
#             Virtuales (PSAV) — ASFI Bolivia
#
# SEPs: SEP-1 (este archivo), SEP-10, SEP-12, SEP-24, SEP-31
# ─────────────────────────────────────────────────────────────────────────────

VERSION = "2.0.0"

NETWORK_PASSPHRASE = "${NETWORK_PASSPHRASE}"

WEB_AUTH_ENDPOINT = "${baseUrl}/api/v1/stellar/auth"
TRANSFER_SERVER_SEP0024 = "${baseUrl}/api/v1/stellar/anchor"
DIRECT_PAYMENT_SERVER = "${baseUrl}/api/v1/stellar/cross-border"
KYC_SERVER = "${baseUrl}/api/v1/stellar/customer"

SIGNING_KEY = "${signingKey}"

HORIZON_URL = "${NETWORK_INFO.horizonUrl}"

ACCOUNTS = [
${accounts}
]

[DOCUMENTATION]
ORG_NAME = "AV Finance SRL"
ORG_DBA = "Alyto"
ORG_URL = "https://${homeDomain}"
ORG_LOGO = "https://${homeDomain}/assets/LogoAlyto.png"
ORG_DESCRIPTION = "Empresa de Tecnología Financiera (ETF) — Proveedor de Servicios de Activos Virtuales (PSAV). Pagos transfronterizos y custodia de activos digitales sobre Stellar Network. DS 5384 (07/05/2025) — ASFI Bolivia."
ORG_PHYSICAL_ADDRESS = "La Paz, Bolivia"
ORG_SUPPORT_EMAIL = "${process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app'}"
ORG_OFFICIAL_EMAIL = "${process.env.ADMIN_EMAIL ?? 'admin@alyto.app'}"

[[PRINCIPALS]]
name = "Alvaro Valdez"
email = "${process.env.ADMIN_EMAIL ?? 'admin@alyto.app'}"

[[CURRENCIES]]
code = "USDC"
issuer = "${usdcIssuer}"
display_decimals = 2
name = "USD Coin"
desc = "Circle USD Coin — activo de tránsito principal en la red Alyto"
conditions = "Operado por Circle Internet Financial. Custodia bajo PSAV — DS 5384."
is_asset_anchored = true
anchor_asset_type = "fiat"
anchor_asset = "USD"
status = "${NETWORK_INFO.name === 'mainnet' ? 'live' : 'test'}"
`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).send(toml);
}
