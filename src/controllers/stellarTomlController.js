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
 * distingue mainnet/testnet por STELLAR_NETWORK. El SIGNING_KEY sale de la cuenta
 * de firma SEP-10 dedicada (SEP10_SIGNING_PUBLIC, separada de la tesorería) y las
 * cuentas de ACCOUNTS son solo llaves públicas (seguras para exponer).
 */

import { ASSETS, NETWORK_PASSPHRASE, NETWORK_INFO, SEP10_SIGNING_PUBLIC } from '../config/stellar.js';

/**
 * GET /.well-known/stellar.toml
 * Sirve el descriptor SEP-1 con Content-Type text/plain + CORS abierto
 * (requerido por wallets que corren en navegador).
 */
export function renderStellarToml(req, res) {
  const homeDomain = process.env.HOME_DOMAIN ?? 'alyto.app';
  const baseUrl    = process.env.STELLAR_ANCHOR_BASE_URL ?? `https://api.${homeDomain}`;

  // SIGNING_KEY: cuenta de firma SEP-10 dedicada (higiene de llaves; ver
  // SEP10_SIGNING_PUBLIC en config/stellar.js). Con el fallback legacy coincide
  // con la tesorería SRL hasta que se setee STELLAR_SEP10_SECRET_KEY.
  const signingKey  = SEP10_SIGNING_PUBLIC;
  const treasuryKey = process.env.STELLAR_SRL_PUBLIC_KEY ?? '';
  const usdcIssuer  = ASSETS.USDC.getIssuer();

  // ACCOUNTS: cuentas controladas que un tercero puede verificar on-chain —
  //   · SIGNING_KEY (firma SEP-10)  · tesorería SRL (custodia/distribución USDC).
  // Se OMITE la channel account (STELLAR_MASTER_PUBLIC): es infra de fees XLM,
  // no aporta transparencia y solo expone superficie operativa. `Set` dedupe el
  // caso legacy en que firma y tesorería son la misma cuenta.
  const accounts = [...new Set([signingKey, treasuryKey].filter(Boolean))]
    .map(k => `  "${k}",`).join('\n');

  // Dirección física completa desde env (AV_FINANCE_ADDRESS, reusada de los PDFs
  // SRL); fallback conservador si aún no está poblada.
  const physicalAddress = process.env.AV_FINANCE_ADDRESS?.trim() || 'La Paz, Bolivia';

  // Campos DOCUMENTATION opcionales — solo se emiten si hay dato (no líneas vacías).
  const optionalDocLines = [
    process.env.SRL_PHONE_NUMBER
      && `ORG_PHONE_NUMBER = "${process.env.SRL_PHONE_NUMBER}"`,
    process.env.ORG_PHYSICAL_ADDRESS_ATTESTATION
      && `ORG_PHYSICAL_ADDRESS_ATTESTATION = "${process.env.ORG_PHYSICAL_ADDRESS_ATTESTATION}"`,
  ].filter(Boolean).join('\n');

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
ORG_PHYSICAL_ADDRESS = "${physicalAddress}"
ORG_SUPPORT_EMAIL = "${process.env.SUPPORT_EMAIL ?? 'soporte@alyto.app'}"
ORG_OFFICIAL_EMAIL = "${process.env.ADMIN_EMAIL ?? 'admin@alyto.app'}"
${optionalDocLines ? optionalDocLines + '\n' : ''}
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
redemption_instructions = "USDC es emitido y redimible a USD por Circle Internet Financial (issuer on-chain). AV Finance SRL (Alyto), como PSAV bajo DS 5384, provee custodia y on/off-ramp BOB↔USDC en Bolivia — no emite ni redime USDC contra USD."
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
