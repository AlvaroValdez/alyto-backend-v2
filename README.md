# Alyto

**A supervised Stellar anchor for Bolivia, operated by AV Finance SRL.**

Alyto is a payment rail built on the Stellar network. It provides custodial USDC
accounts, a full SEP-compliant anchor, and cross-border settlement, operated by
AV Finance SRL, a Bolivian Financial Technology Company (ETF) and Virtual
Asset Service Provider (PSAV). AV Finance SRL is in the process of entering
ASFI's Controlled Testing Environment (Entorno Controlado de Pruebas) under
Supreme Decree 5384, the supervised stage that precedes the full ETF/PSAV
license.

## Overview

Alyto runs as a live anchor on Stellar mainnet. It pairs an institutional
custody model with the full SEP suite, so wallets and applications across the
Stellar ecosystem can authenticate, complete KYC, and move value through a
supervised Bolivian entity. This repository holds the backend that powers
authentication, custody, compliance, and settlement.

## Supported SEPs

All of the following are implemented and served in production (see the public
[stellar.toml](https://alyto.app/.well-known/stellar.toml)):

- **SEP-1** (Stellar Info File): published dynamically per environment.
- **SEP-10** (Web Authentication): challenge and response login signed by a
  dedicated authentication key, separate from any fund-holding account.
- **SEP-12** (KYC API): maps biometric identity verification (document plus
  liveness) to the SEP-12 standard.
- **SEP-24** (Interactive Deposit and Withdrawal): for external Stellar wallets.
- **SEP-31** (Cross-Border Payments): exposes settlement corridors as a
  standard receiving anchor.

## Architecture

Alyto uses a dual-ledger design:

- The **off-chain layer** holds the fiduciary ledger, identity, regulatory
  limits, and product state.
- The **on-chain layer** (Stellar mainnet) holds asset custody and an immutable
  audit record.

The custody model is institutional. On verification, the platform provisions a
Stellar keypair for each user and encrypts the secret key with a managed key
service (AWS KMS), bound to the user's identifier. Users never handle keys.
Network fees are abstracted through Fee Bump transactions, so a user never needs
to hold the native asset. No operation reaches Stellar without prior fiduciary
verification of balance, identity, limits, and compliance.

## Tech stack

- Node.js, Express
- MongoDB (Mongoose)
- Stellar SDK (`@stellar/stellar-sdk`)
- AWS (KMS for custody, S3 with Object Lock for immutable document storage)

## Links

- Stellar info file: https://alyto.app/.well-known/stellar.toml
- Website: https://alyto.app
- API: https://api.alyto.app

## Status

Operational on Stellar mainnet, under active development.

## License

Apache License 2.0. See [LICENSE](LICENSE).
