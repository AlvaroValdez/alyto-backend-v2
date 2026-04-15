# Contexto Global del Proyecto: Alyto Wallet V2.0

## 1. Identidad Corporativa, Entidades y Visión Operativa

**Estructura Corporativa Multi-Jurisdicción:**
- **AV Finance LLC (EE.UU. - Delaware):** Entidad matriz para relaciones bancarias en USD, infraestructura B2B global y gestión de liquidez institucional vía OwlPay Harbor. EIN registrado.
- **AV Finance SpA (Chile):** Entidad operativa en Chile. Motor de recaudación (Pay-in) local vía Fintoc (PISP bajo Ley Fintec 21.521). Pagos B2B regionales.
- **AV Finance SRL (Bolivia):** Entidad en proceso de licencia ETF/PSAV ante ASFI (Decreto Supremo N° 5384). Actúa como Anchor regulado local. Capital social: Bs. 20.000.

**Producto:** Alyto — billetera digital y plataforma financiera Web3.
**Core Business:** Pagos transfronterizos, gestión de tesorería y tokenización de activos sobre la red Stellar.
**Modelo de ingresos:** 1.5% fee transaccional + 0.5% spread FX = 2.0% por operación.
**Tarifas al usuario:** Entre 1.5% y 3% (vs 7-10% del modelo SWIFT tradicional).

**⚠️ REGLA CRÍTICA DE COMPLIANCE:** Está ESTRICTAMENTE PROHIBIDO usar "remesa", "remesas" o "remittances" en código, comentarios, APIs, base de datos o UI. Usar siempre: "cross-border payment", "transferencia internacional", "pay-in/pay-out", "liquidación" o "tokenización".

---

## 2. Estado del Desarrollo (Marzo 2026)

### Fases completadas ✅
- Fases 1-16: Arquitectura base, KYC Stripe Identity, Ledger admin
- Fase 17: Integración Vita Wallet API
- Fase 18A: Motor pagos cross-border CL→LatAm (Fintoc + Vita, operativo)
- Fase 18B: Stellar audit trail (operativo en testnet)
- Fase 18C: Spread configurable desde admin backoffice
- Fase 19A-D: Corredor Bolivia SRL completo (BOB→LatAm, payin manual QR+transferencia, anchorBolivia, test e2e OK)
- Fase 20: Templates KYB SendGrid completos y testeados
- Fase 21: CorporateView LLC (on-ramp institucional Harbor, pendiente activación par USD→USDC/Stellar en sandbox)
- Fase 22: owlPayService.js alineado con Harbor API real (Transfer v2, X-API-KEY, webhook harbor-signature)
- Fase 23: SRLConfigPage admin para gestión de QR Bolivia
- Fase 24: Checklist vars Render producción

### En curso / pendiente 🔄
- Fase 25: Wallet con saldo BOB (Dual Ledger off-chain + Stellar on-chain)
- Fase 26: Congelamiento de fondos vía Trustlines Stellar (exigencia ASFI)
- Fase 27: Punto de Reclamo PRILI (exigencia ASFI protección consumidor)
- Fase 28: Escaneo de sanciones OFAC/ONU/PEPs en tiempo real
- OwlPay MSA: Pendiente corrección entidad (debe ser LLC, no SpA) + activación par on-ramp Stellar
- ASFI: Respuesta regulatoria esperada ~2 semanas desde 11 marzo 2026

---

## 3. Arquitectura de Pagos Implementada

### Flujo Chile (SpA) ✅
Usuario CLP → Fintoc payin (PISP A2A) → IPN confirma
→ dispatchPayout → Vita Wallet → beneficiario destino
→ Stellar audit trail registrado

### Flujo Bolivia SRL — payin manual ✅
Usuario BOB → QR bancario o transferencia a Banco Bisa
→ Admin confirma en Ledger → dispatchPayout
→ Vita Wallet USD → beneficiario destino (CO, PE, CL, AR, MX, BR)
→ Tasa BOB/USDT configurable desde admin (actualmente 9.31)
→ Fondeo manual via Binance P2P → USDT → Vita wallet

### Corredor Institucional LLC — on-ramp Harbor ✅ (sandbox pendiente activación)
Empresa cliente USD → wire transfer → OwlPay Harbor
→ Harbor convierte USD → USDC → wallet Stellar del cliente
→ Webhook harbor-signature confirma → Stellar audit trail

### Routing por corredor:
- CL→CO,PE,AR,MX,BR → Vita (retail LatAm) — Escenario B
- CL→BO → anchorBolivia (SRL paga manual) — Escenario B+C
- BO→CO,PE,AR,CL,MX,BR → Vita + conversión BOB/USDC — Escenario C
- LLC→Global → OwlPay Harbor on-ramp — Escenario A

---

## 4. Stack Técnico y Servicios Integrados

### Backend
- Node.js + Express.js + MongoDB/Mongoose + JWT
- Deploy: Render (backend) + Railway (alternativo)

### Frontend
- React + Vite + Tailwind CSS
- Deploy: Render (frontend)
- Dominio: alyto.app (nameservers Bluehost)

### Servicios integrados
| Servicio | Uso | Estado |
|----------|-----|--------|
| Stripe Identity | KYC biométrico | ✅ |
| Fintoc | Pay-in CLP, PISP modelo | ✅ |
| Vita Wallet API | Pay-out 50+ países LatAm | ✅ |
| OwlPay Harbor | On-ramp institucional B2B USD→USDC | ✅ código / ⚠️ sandbox pendiente |
| Stellar Network | Audit trail, tránsito, tokenización futura | ✅ testnet |
| SendGrid | Emails transaccionales | ✅ |
| Firebase | Push notifications | ✅ |
| Sentry | Monitoreo errores | ✅ |
| Stripe Identity | KYC | ✅ |

### Repositorios
- Backend: github.com/AlvaroValdez/alyto-backend-v2
- Frontend: github.com/AlvaroValdez/alyto-frontend-v2

### URLs producción
- Backend: https://alyto-backend-v2.onrender.com
- Frontend: https://alyto-frontend-v2.onrender.com

---

## 5. Modelos MongoDB Principales

| Modelo | Propósito |
|--------|-----------|
| User | kycStatus, kybStatus, legalEntity (SpA/LLC/SRL), accountType |
| Transaction | transactionId, status, fees, beneficiary, ipnLog, stellarTxId |
| TransactionConfig | corredores con fees configurables desde admin |
| BusinessProfile | KYB empresas con documentos y estado de revisión |
| FundingRecord | registro fondeo manual Binance P2P |
| ExchangeRate | tasas configurables (BOB/USDT: 9.31, CLP/USD: 966) |
| SRLConfig | QR images para payin manual Bolivia |

---

## 6. Variables de Entorno Críticas

### Vita
VITA_API_URL=https://api.stage.vitawallet.io/api/businesses
VITA_LOGIN=e0f5ee3c...
VITA_TRANS_KEY=s+OtCG7e...
VITA_SECRET=f0fbe9c5...
VITA_BUSINESS_WALLET_UUID=97f3c111-e1b6-46a0-a3e1-c56f94ffbca1
VITA_ENVIRONMENT=sandbox
VITA_NOTIFY_URL=https://alyto-backend-v2.onrender.com/api/v1/ipn/vita

### Fintoc
FINTOC_SECRET_KEY=sk_test_DnLuBjN66...
FINTOC_WEBHOOK_SECRET=whsec_test_DrpQ5t...
FINTOC_API_URL=https://api.fintoc.com/v1

### OwlPay Harbor
OWLPAY_API_KEY=key_sandbox_TgS3TkHo...
OWLPAY_BASE_URL=https://harbor-sandbox.owlpay.com/api/v1
OWLPAY_WEBHOOK_SECRET=whs_...
- Auth header: X-API-KEY (no Bearer)
- Webhook header: harbor-signature (formato: t=timestamp,v1=hmac_hex)
- Firma: HMAC-SHA256(timestamp.rawBody, secret)
- Transfer v2: POST /v2/transfers/quotes → GET /v2/transfers/quotes/:id/requirements → POST /v2/transfers
- Campo requerido: on_behalf_of (customer UUID de Harbor)
- MSA pendiente: corrección entidad a LLC + activación par USD→USDC/Stellar

### Stellar
STELLAR_NETWORK=testnet
STELLAR_SPA_SECRET_KEY=S...
STELLAR_LLC_SECRET_KEY=S...
STELLAR_SRL_SECRET_KEY=S...

### Bolivia
BOB_USD_RATE=9.31
SRL_BANK_NAME=Banco Bisa
SRL_ACCOUNT_NUMBER=...
SRL_ACCOUNT_HOLDER=AV Finance SRL
SRL_ACCOUNT_TYPE=Cuenta Corriente

### SendGrid templates
SENDGRID_TEMPLATE_INITIATED=d-...
SENDGRID_TEMPLATE_COMPLETED=d-...
SENDGRID_TEMPLATE_FAILED=d-...
SENDGRID_TEMPLATE_ADMIN_BOLIVIA=d-18c7f16b7df94398a03e8bdc113a8941
SENDGRID_TEMPLATE_KYB_RECEIVED=d-d71984ce084e47b4a46e5e8fdf789831
SENDGRID_TEMPLATE_KYB_APPROVED=d-313e9a5de7b1435f9081ac7182cd9f8a
SENDGRID_TEMPLATE_KYB_REJECTED=d-83900f9cb40440e68bc402eeb1ddace6
SENDGRID_TEMPLATE_KYB_MORE_INFO=d-be3bdd45e6a24878aec57b8ecb50a076
SENDGRID_TEMPLATE_ADMIN_KYB=d-8bf2a6e1244743ea95248416b1335f80

---

## 7. Acuerdos Legales y Regulatorios

- **Modelo legal:** No-Custodia Web3/SaaS — AV Finance no capta ni custodia fondos
- **Chile:** AV Finance SpA opera como proveedor tecnológico bajo Ley Fintec 21.521 usando Fintoc (PISP)
- **Bolivia:** AV Finance SRL en proceso ASFI ETF/PSAV — respuesta esperada ~2 semanas desde 11/03/2026
- **OwlPay:** End User Model acordado, 50 bps flat, MSA v1.0 en revisión (pendiente cambio entidad SpA→LLC y activación corredor on-ramp Stellar). Activation fee $500 USD acreditable. Annual fee $500 waiveable.
- **KYB:** Manual por admin para primeros clientes B2B

---

## 8. Compromisos ASFI (Memoria Institucional 11/03/2026)

Funciones comprometidas ante ASFI que deben implementarse:

| # | Función | Estado | Fase |
|---|---------|--------|------|
| 1 | Wallet con saldo BOB (Dual Ledger) | ⬜ Pendiente | 25 |
| 2 | Congelamiento fondos Trustlines Stellar | ⬜ Pendiente | 26 |
| 3 | Punto de Reclamo PRILI en app | ⬜ Pendiente | 27 |
| 4 | Escaneo sanciones OFAC/ONU/PEPs | ⬜ Pendiente | 28 |
| 5 | Monitoreo heurístico / alertas ROS UIF | ⬜ Futuro | - |
| 6 | Módulo educación financiera | ⬜ Futuro | - |

**Arquitectura Dual Ledger comprometida:**
- Capa Fiduciaria (off-chain): MongoDB administra identidad KYC y saldos locales BOB
- Capa Blockchain (on-chain): Stellar mueve activos digitales (USDC) sin exponer identidades
- Ninguna transferencia toca Stellar sin provisión fiduciaria 100% verificada (transacciones atómicas)

---

## 9. Instrucciones de Comportamiento para Claude Code

1. **Seguridad Absoluta:** Nunca exponer llaves privadas, secrets ni API keys en código fuente. Usar SIEMPRE variables de entorno.
2. **Aislamiento de corredores:** Bolivia (SRL) y Chile (SpA) son flujos completamente separados. NO mezclar lógica entre entidades.
3. **No romper lo que funciona:** Cualquier fix de Bolivia debe estar aislado. Los corredores CL→LatAm con Fintoc/Vita están operativos — no tocarlos.
4. **Commits granulares:** Después de cada tarea, commit descriptivo + push.
5. **Nunca crear archivos directamente:** Siempre como bloque de instrucciones para Claude Code ejecutar.
6. **Arquitectura Multi-Entidad:** Siempre identificar bajo qué jurisdicción (LLC/SpA/SRL) se ejecuta la transacción.
7. **Resiliencia:** Si un proveedor falla, registrar sin colapsar y usar fallback.
8. **Formato transactionId:** ALY-B-TIMESTAMP-NANOID (SpA) / ALY-C-TIMESTAMP-NANOID (SRL) / ALY-A-TIMESTAMP-NANOID (LLC)
9. **Bolivia payin:** NUNCA llamar a Fintoc ni Vita para el payin SRL. Es siempre manual.
10. **Tasa BOB/USDT:** Viene de MongoDB (ExchangeRate model) con fallback a env BOB_USD_RATE=9.31.
11. **profitRetention:** NUNCA mostrar al usuario final. Solo visible en admin.

---

## 10. Skills Nativos (Uso Obligatorio)

| Skill | Activar cuando... |
|-------|------------------|
| `ux-alyto` | Cualquier creación o modificación de componentes React/Vite |
| `Stellar_Integration_Alyto` | Funciones de red blockchain, Trustlines, Fee Bump |
| `Compliance_Bolivia_Alyto` | Motor de facturación PDF, Comprobante Oficial SRL |
| `Multi_Entity_Routing_Alyto` | Controladores de pagos, flujos de fondos, decisión de proveedor |
| `wallet-bob` | Wallet con saldo BOB, Dual Ledger, depósitos/retiros Bolivia |
| `trustlines-stellar` | Congelamiento fondos, control ASFI, UIF compliance |
| `compliance-uif` | Monitoreo heurístico, alertas ROS, escaneo sanciones OFAC |
| `prili-reclamos` | Punto de reclamo, gestión incidencias, protección consumidor |

---

## 11. Decisión Estratégica de Routing (Vita vs OwlPay)

**Vita Wallet** → usar para:
- Todos los corredores retail LatAm (CO, PE, AR, MX, BR, CL)
- Montos pequeños/medianos (usuarios personales y business SRL/SpA)
- Pay-out en moneda local directamente a cuenta bancaria

**OwlPay Harbor** → usar para:
- Corredores institucionales B2B (USD, EUR, CNY, BRL, MXN, AED)
- Montos grandes (mínimo $500 USD acordado en End User Model)
- Clientes LLC con KYB aprobado
- Off-ramp USDC→fiat en mercados no cubiertos por Vita

**Decisión de routing automático en dispatchPayout:**
if (legalEntity === 'LLC' && amount >= 500) → OwlPay Harbor
else if (destinationCountry en cobertura Vita) → Vita Wallet
else → OwlPay Harbor como fallback

---

## 🏦 Arquitectura del Modelo Anchor — AV Finance SRL (Hito v2.0)

> Documentado: Abril 2026 | Versión: 2.0 | Estado: Producción

### Concepto fundamental

AV Finance SRL opera como **anchor de bolivianos (BOB)** en la red
de pagos de Alyto Wallet. Esto significa que AV Finance SRL es la
única entidad que recibe fondos en BOB de los usuarios bolivianos —
ningún proveedor externo (Vita, Harbor, OwlPay) toca directamente
las cuentas bancarias bolivianas.

El modelo se divide en tres capas:

```
┌─────────────────────────────────────────────────────────────┐
│                    CAPA 1 — PAYIN BOB                       │
│  Usuario transfiere BOB → Cuenta bancaria AV Finance SRL    │
│  Admin confirma recepción en Ledger                         │
│  Proveedor: MANUAL (Banco Bisa / Banco Nacional Bolivia)    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                 CAPA 2 — CONVERSIÓN INTERNA                 │
│  BOB → USDT/USDC vía Binance P2P (operación manual admin)   │
│  USDC acreditado en wallet Stellar SRL                      │
│  Registrado en FundingRecord (modelo de tesorería)          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                   CAPA 3 — PAYOUT DESTINO                   │
│  Proveedor seleccionado según destino del corredor          │
│  Vita Wallet → 21 destinos LatAm/Europa                     │
│  OwlPay Harbor → China (CNY), Nigeria (NGN) + futuros       │
│  Manual Admin → Bolivia (BOB, solo corredor cl-bo SpA)      │
└─────────────────────────────────────────────────────────────┘
```

---

### Flujos por proveedor de payout

#### Flujo A — BOB → LatAm/Europa via Vita Wallet (21 corredores)

```
[Usuario]
  │ Transfiere BOB a Banco AV Finance SRL
  ↓
[Admin — Ledger]
  │ Confirma payin → status: payin_confirmed
  ↓
[dispatchPayout()]
  │ Llama a Vita API con instrucción de pago
  │ Vita debita de cuenta AV Finance SRL en Vita
  ↓
[Vita Wallet]
  │ Entrega en moneda local al beneficiario
  │ Confirma vía IPN → status: completed
  ↓
[Usuario]
  Recibe push "¡Dinero entregado! ✓" + email
```

**Corredores activos:** bo-ar, bo-br, bo-ca, bo-cl, bo-co, bo-cr,
bo-do, bo-ec, bo-es, bo-gt, bo-hk, bo-ht, bo-mx, bo-pa, bo-pe,
bo-pl, bo-py, bo-sv, bo-us, bo-uy, bo-ve

**Método payout Vita:**
- `createPayout()` — corredores estándar
- `createVitaSentPayout()` — VITA_SENT_ONLY_COUNTRIES: { GT, SV, ES, PL }

---

#### Flujo B — BOB → China/Nigeria via OwlPay Harbor (2 corredores activos)

```
[Usuario]
  │ Transfiere BOB a Banco AV Finance SRL
  ↓
[Admin — Ledger]
  │ Confirma payin → status: payin_confirmed
  ↓
[dispatchPayout() → tryOwlPayV2()]
  │ 1. getHarborQuote() — obtiene tasa USDC→CNY/NGN
  │ 2. createHarborTransfer() — Harbor genera instruction_address
  │ 3. Pre-check FundingRecord.getAvailableUSDC('SRL')
  │ 4. sendUSDCToHarbor() — envía USDC desde wallet Stellar SRL
  │    a instruction_address (chain: TBD — pendiente Sam/OwlPay)
  ↓
[OwlPay Harbor]
  │ Detecta USDC on-chain
  │ IPN: transfer.source_received → status: payout_sent
  │ Entrega CNY/NGN al beneficiario
  │ IPN: transfer.completed → status: completed
  ↓
[Usuario]
  Recibe push "¡Dinero entregado! ✓" + email
```

**Corredores activos:** bo-cn (CNY), bo-ng (NGN)

**Estado sendUSDCToHarbor:**
- `OWLPAY_USDC_SEND_ENABLED=0` → modo manual (admin recibe email con instrucción)
- `OWLPAY_USDC_SEND_ENABLED=1` → automático (activar cuando Sam confirme chain)

**Corredores pendientes Harbor:** bo-au (AUD), bo-gb (GBP),
bo-jp (JPY Q1 2026), bo-sg (SGD Q1 2026), bo-za (ZAR),
bo-ae-srl (AED Q1 2026)

---

#### Flujo C — CLP → BOB via AV Finance SRL (anchor completo)

```
[Usuario Chile — SpA]
  │ Paga CLP via Fintoc → status: payin_pending
  ↓
[Fintoc IPN]
  │ Confirma pago → status: payin_confirmed
  ↓
[dispatchPayout()]
  │ payoutMethod === 'anchorBolivia' → PARA
  │ No llama a ningún proveedor externo
  │ Envía email a admin: adminBoliviaAlert
  ↓
[Admin — Manual]
  │ Recibe email con datos del beneficiario en Bolivia
  │ Ejecuta transferencia bancaria BOB al beneficiario
  │ Confirma en Ledger → status: completed
  ↓
[Usuario]
  Recibe push "¡Dinero entregado! ✓" + email
```

**Corredor:** cl-bo (SpA, CLP → BOB)
**Liquidez BOB:** AV Finance SRL mantiene saldo en cuentas bolivianas
**Nota:** Este es el único flujo donde AV Finance SRL ejecuta
el pago final en Bolivia.

---

### Modelo de liquidez USDC (Tesorería SRL)

```
ENTRADA DE USDC:
  Admin compra USDT/USDC en Binance P2P con BOB recibido
  → Transfiere USDC a STELLAR_SRL_PUBLIC_KEY
  → Registra FundingRecord en sistema (tipo: binance_p2p)
  → Status: confirmed → saldo disponible aumenta

SALIDA DE USDC:
  dispatchPayout() → sendUSDCToHarbor() → USDC sale de wallet Stellar SRL
  → FundingRecord comprometido (in-flight tracking)
  → Harbor confirma → saldo disponible reduce definitivamente

PRE-CHECK EN PAYOUT:
  FundingRecord.getAvailableUSDC('SRL') >= transaction.digitalAssetAmount
  Si insuficiente → status: pending_funding + email admin
```

**Modelos involucrados:**
- `FundingRecord.js` — registro de entradas de liquidez
- `WalletUSDC.js` — saldo USDC por usuario (conversiones BOB→USDC)
- `ExchangeRate.js` — tasa BOB/USDT (actualizada manualmente vía admin)

---

### Estado de corredores SRL — Abril 2026

| Estado | Provider | Count | Corredores |
|--------|----------|-------|------------|
| 🟢 Activo | Vita Wallet | 21 | bo-ar, bo-br, bo-ca, bo-cl, bo-co, bo-cr, bo-do, bo-ec, bo-es, bo-gt, bo-hk, bo-ht, bo-mx, bo-pa, bo-pe, bo-pl, bo-py, bo-sv, bo-us, bo-uy, bo-ve |
| 🟢 Activo | OwlPay Harbor | 2 | bo-cn, bo-ng |
| 🔻 Inactivo | OwlPay Harbor | 7 | bo-au, bo-gb, bo-jp, bo-sg, bo-za, bo-ae-srl, bo-eu-srl |
| 🔻 Inactivo | OwlPay Harbor | 1 | bo-us-owlpay (LLC launch) |
| 🔻 Inactivo | OwlPay Harbor | 2 | bo-cn-srl, bo-gb-srl (duplicados) |
| **Total** | | **33** | |

---

### Entidades legales y responsabilidades

| Entidad | País | Rol en el modelo anchor |
|---------|------|------------------------|
| AV Finance SRL | Bolivia | Anchor BOB — recibe y custodia BOB, opera corredores bo-* |
| AV Finance SpA | Chile | Opera corredores cl-*, recibe CLP vía Fintoc |
| AV Finance LLC | Delaware, EEUU | Opera corredores us-*, recibe USD vía Vita/OwlPay |

**Regulación aplicable a SRL:**
- ASFI Bolivia — PSAV en trámite (Circular 2/2022)
- UAF Bolivia — reporte de operaciones sospechosas
- Límites de transacción configurables en TransactionConfig

---

### Variables de entorno críticas para el modelo anchor SRL

```env
# Stellar wallet SRL (custodio de USDC)
STELLAR_SRL_SECRET_KEY=      # nunca commitear
STELLAR_SRL_PUBLIC_KEY=      # dirección pública Stellar SRL

# OwlPay Harbor
OWLPAY_API_KEY=              # Default Key (producción)
OWLPAY_BASE_URL=             # sandbox: harbor-sandbox.owlpay.com/api
                             # prod:    harbor-api.owlpay.com/api
OWLPAY_WEBHOOK_SECRET=       # para verificar harbor-signature
OWLPAY_CUSTOMER_UUID_SRL=    # UUID del customer AV Finance SRL en Harbor
OWLPAY_USDC_SEND_ENABLED=0   # 0=manual, 1=automático (activar post Sam)
OWLPAY_SOURCE_CHAIN=stellar  # chain fuente USDC (pendiente confirmación Sam)

# Tipo de cambio BOB
# Actualizar manualmente via admin panel o ExchangeRate model
# Fallback: 9.31 BOB/USDT (NO usar en producción sin actualizar)
```

---

### Decisiones arquitecturales registradas

| Fecha | Decisión | Razón |
|-------|----------|-------|
| 2026-01 | USD como pivot currency real (no USDC/USDT) | USDC en Stellar es solo audit trail; Vita maneja USD internamente |
| 2026-02 | Modelo no-custodial Web3/SaaS | AV Finance nunca toca fondos del usuario directamente |
| 2026-03 | anchorBolivia para cl-bo | Bolivia no tiene infraestructura bancaria conectada a redes internacionales automáticas |
| 2026-04 | OwlPay Harbor v2 para CNY/NGN | Vita no cubre China ni Nigeria; Harbor tiene rails locales directos |
| 2026-04 | OWLPAY_USDC_SEND_ENABLED=0 | sendUSDCToHarbor pendiente confirmación chain con Sam (Stellar vs ETH) |
