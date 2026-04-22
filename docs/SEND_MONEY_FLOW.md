# Send Money Flow — Specification v1.0

> **Status:** Contract document — DO NOT modify without updating CHANGELOG_FLOWS.md first
> **Last updated:** April 2026
> **Applies to:** AV Finance SRL (Bolivia) — BOB → LatAm corridors via Vita Wallet
> **Related entities:** SpA (Chile) and LLC (institutional) follow analogous patterns

---

## 1. Design Principles

These principles are **inviolable**. Any proposed change must be evaluated against them first.

### 1.1 User promises = System delivery
The amount the user sees in the quote is **exactly** what the beneficiary receives. No drift, no adjustment, no "approximate" wording. If Vita's live rate would deliver a different amount, the quote recalculates. If the user confirms, the system locks to that amount.

### 1.2 Zero hidden markup on execution
`vitaRateMarkup` is **removed** from the calculation chain. The quote shows the same effective rate Vita will apply. Revenue comes from explicit fees (`alytoCSpread`, `fixedFee`, `profitRetention`) — never from rate manipulation.

### 1.3 Three steps maximum
The flow has **exactly 3 steps**. Any feature that would require a 4th step must instead fit within one of the existing steps.

### 1.4 Progressive disclosure
By default, the UI shows only the essential: input amount, output amount, total fee, estimated time. Details (rate, pivot currency, fee breakdown) are available on demand via expandable sections — never imposed.

### 1.5 Audit trail is internal
USDC on Stellar exists for compliance and immutable audit. It is **never** shown to the end user. Technical terms like "USDC", "Stellar", "pivot currency" do not appear in user-facing UI.

---

## 2. Navigation Contract — 3 Steps

```
┌──────────────────────────────────────────────────────────────────┐
│  STEP 1 — Destination + Amount + Beneficiary                     │
│  Route: /send/details                                            │
│                                                                  │
│  - Select destination country                                    │
│  - Enter amount (origin currency)                                │
│  - Select or create beneficiary                                  │
│  - Live quote updates inline as user types                       │
│  - [Continuar] disabled until all fields valid                   │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│  STEP 2 — Review + Confirm                                       │
│  Route: /send/review                                             │
│                                                                  │
│  - Immutable summary of Step 1                                   │
│  - Expandable "Ver detalles" section                             │
│  - [Ver detalles ↓] reveals: fee breakdown, effective rate       │
│  - [Editar] returns to Step 1 (keeps all data)                   │
│  - [Confirmar] proceeds to Step 3                                │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│  STEP 3 — Payment Instructions + Proof Upload                    │
│  Route: /send/payment/:txId                                      │
│                                                                  │
│  - Transaction created with status: payin_pending                │
│  - Bank transfer instructions shown                              │
│  - MANDATORY: comprobante upload before final submit             │
│  - [Ya transferí, subir comprobante] enabled after upload        │
│  - Redirect to /transactions/:txId on success                    │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 Step 1 — Details

**Layout:**
```
┌─────────────────────────────────────┐
│  Envía dinero a                     │
│  ┌─────────────────────┐            │
│  │ 🇨🇴 Colombia       ▼ │            │
│  └─────────────────────┘            │
│                                     │
│  Monto                              │
│  ┌─────────────┬──────┐             │
│  │    635      │ BOB  │             │
│  └─────────────┴──────┘             │
│                                     │
│  Beneficiario recibe                │
│  ┌─────────────────────────┐        │
│  │    267,483 COP          │        │
│  └─────────────────────────┘        │
│                                     │
│  Beneficiario                       │
│  ┌─────────────────────────┐        │
│  │ Marina Valdez   ▼       │        │
│  └─────────────────────────┘        │
│  [+ Nuevo beneficiario]             │
│                                     │
│  [Continuar]                        │
└─────────────────────────────────────┘
```

**Validations:**
- Amount ≥ corridor minimum (300 BOB for most SRL corridors)
- Destination country must have active corridor
- Beneficiary must match destination country
- Quote must be fresh (< 60 seconds old)

**Live quote behavior:**
- Debounced 500ms after user stops typing
- Shows loader "Calculando..." during fetch
- WebSocket refresh every 60 seconds
- On rate change > 1%: shows toast "Tasa actualizada"

### 2.2 Step 2 — Review

**Default (collapsed) view:**
```
┌─────────────────────────────────────┐
│  Revisar transferencia              │
│                                     │
│  De ti                              │
│    David Valdez              ✓      │
│    Envías: 635 BOB                  │
│                                     │
│  Para Marina Valdez                 │
│    🇨🇴 Colombia                     │
│    Bancolombia · ****5123           │
│    Recibe: 267,483 COP              │
│                                     │
│  ⏱ Llega en: Pocas horas            │
│                                     │
│  [Ver detalles ↓]                   │
│                                     │
│  [Editar]      [Confirmar]          │
└─────────────────────────────────────┘
```

**Expanded detail view:**
```
┌─────────────────────────────────────┐
│  Ver detalles ↑                     │
│                                     │
│  Envías                             │
│    635.00 BOB                       │
│                                     │
│  Comisión Alyto                     │
│    25.00 BOB   ($3.58 USD)          │
│                                     │
│  Tasa aplicada                      │
│    1 BOB = 438.52 COP               │
│                                     │
│  Beneficiario recibe                │
│    267,483 COP                      │
│                                     │
│  Tiempo estimado                    │
│    Pocas horas (máx 24h hábiles)    │
└─────────────────────────────────────┘
```

**Rules:**
- No "tasa de cambio de mercado" disclosed — only the effective rate
- Fee shown in origin currency (BOB) AND USD equivalent
- No mention of USDC, Stellar, Vita, corridor IDs
- "Tiempo estimado" per corridor (Vita LatAm: pocas horas; OwlPay: 1-3 días; BO manual: 24h)

### 2.3 Step 3 — Payment

**Layout:**
```
┌─────────────────────────────────────┐
│  Realiza tu pago                    │
│                                     │
│  Transfiere 635 BOB a:              │
│  ┌─────────────────────────────┐    │
│  │ AV Finance SRL              │    │
│  │ Banco: XXX                  │    │
│  │ Cuenta: 1234567890          │    │
│  │ ID: ALY-C-...  📋           │    │
│  └─────────────────────────────┘    │
│                                     │
│  📎 Comprobante [OBLIGATORIO]       │
│  ┌─────────────────────────────┐    │
│  │     Subir comprobante       │    │
│  │     JPG, PNG, PDF (5MB)     │    │
│  └─────────────────────────────┘    │
│                                     │
│  ⚠ Sin comprobante no podemos       │
│    verificar tu transferencia       │
│                                     │
│  [Cancelar]    [Confirmar envío]    │
│  (disabled until proof uploaded)    │
└─────────────────────────────────────┘
```

---

## 3. Mathematical Specification

### 3.1 Definitions

Let:
```
A          = user input amount (origin currency, e.g. 635 BOB)
Cₒ         = origin currency (BOB for SRL)
Cₓ         = destination currency (COP, BRL, MXN, etc.)
corridor   = TransactionConfig document

corridor.alytoCSpread            = spread percentage (e.g. 2%)
corridor.fixedFee                = fixed fee in origin currency (e.g. 5 BOB)
corridor.payinFeePercent         = payin fee percentage (typically 0)
corridor.payoutFeeFixed          = payout fee in USD (typically 0)
corridor.profitRetentionPercent  = hidden margin percentage (e.g. 1%)

bobPerUsdc = exchange rate BOB → USDC (from Binance P2P or env fallback)
vitaRate   = exchange rate USDC → Cₓ (from Vita API, REAL, no markup)
```

### 3.2 Calculation chain — UNIFIED FORMULA

**This is the ONLY formula. It is used in BOTH `calculateBOBQuote` and `quoteSocket.js`. Any divergence is a bug.**

```javascript
// Step 1: Calculate fees in origin currency
const payinFee         = A * corridor.payinFeePercent / 100;
const alytoCSpread     = A * corridor.alytoCSpread / 100;
const fixedFee         = corridor.fixedFee;
const profitRetention  = A * corridor.profitRetentionPercent / 100;

// Step 2: Visible fees (shown to user as "Comisión Alyto")
const visibleFees      = payinFee + alytoCSpread + fixedFee;
const totalDeducted    = visibleFees;               // ← user-facing total

// Step 3: Internal fees (includes hidden retention)
const totalDeductedReal = visibleFees + profitRetention;  // ← internal only

// Step 4: Net amount for conversion
const netBOB           = A - totalDeductedReal;

// Step 5: USDC transit amount (audit trail only, not visible to user)
const usdcTransitAmount = round2(netBOB / bobPerUsdc);

// Step 6: Destination amount — USING RAW VITA RATE (no markup)
const payoutFeeInDest  = corridor.payoutFeeFixed * vitaRate;  // convert USD fee to dest
const destinationAmount = round2(
  (usdcTransitAmount * vitaRate) - payoutFeeInDest
);

// Step 7: Effective rate for user display
const effectiveRate    = round2(destinationAmount / A);
```

### 3.3 Example — 635 BOB → COP

Given:
```
A                            = 635 BOB
corridor.alytoCSpread        = 2%
corridor.fixedFee            = 5 BOB
corridor.payinFeePercent     = 0%
corridor.payoutFeeFixed      = 0 USD
corridor.profitRetentionPercent = 1%
bobPerUsdc                   = 9.31
vitaRate (USD → COP)         = 4,201.32  (hypothetical real Vita rate)
```

Calculations:
```
payinFee          = 0
alytoCSpread      = 635 × 0.02 = 12.70 BOB
fixedFee          = 5 BOB
profitRetention   = 635 × 0.01 = 6.35 BOB

visibleFees       = 0 + 12.70 + 5 = 17.70 BOB     ← "Comisión Alyto"
totalDeducted     = 17.70 BOB
totalDeductedReal = 17.70 + 6.35 = 24.05 BOB     ← internal

netBOB            = 635 - 24.05 = 610.95 BOB

usdcTransitAmount = round2(610.95 / 9.31) = 65.62 USDC

destinationAmount = round2(65.62 × 4,201.32 - 0) = 275,698.64 COP

effectiveRate     = round2(275,698.64 / 635) = 434.17 COP/BOB
```

User sees:
```
Envías:           635 BOB
Comisión:         17.70 BOB
Recibe:           275,698.64 COP
Tasa:             1 BOB = 434.17 COP
```

### 3.4 Display rounding

All user-facing amounts use these rules:

| Currency | Decimals | Format |
|---|---|---|
| BOB | 2 | `1,234.56 BOB` |
| USD | 2 | `$1,234.56 USD` |
| USDC | — | Not shown to user |
| COP | 0 | `267,483 COP` |
| ARS | 2 | `45,123.45 ARS` |
| BRL | 2 | `1,234.56 BRL` |
| MXN | 2 | `12,345.67 MXN` |
| Default | 2 | `1,234.56 XXX` |

### 3.5 What is stored on Transaction

```javascript
{
  alytoTransactionId: "ALY-C-...",
  originAmount: 635,                      // A
  originCurrency: "BOB",                  // Cₒ
  destinationAmount: 275698.64,           // what we promise
  destinationCurrency: "COP",             // Cₓ
  
  exchangeRate: 434.17,                   // effectiveRate (for user display)
  
  conversionRate: {
    fromCurrency: "BOB",
    toCurrency: "USDC",
    rate: 9.31,
    convertedAmount: 65.62
  },
  
  digitalAssetAmount: 65.62,              // USDC for audit
  digitalAsset: "USDC",
  
  fees: {
    payinFee: 0,
    alytoCSpread: 12.70,
    fixedFee: 5,
    payoutFee: 0,
    profitRetention: 6.35,                // internal
    totalDeducted: 17.70,                 // user-facing
    totalDeductedReal: 24.05,             // internal
    feeCurrency: "BOB",
    vitaRateMarkup: 0                     // ← EXPLICITLY ZERO per this spec
  },
  
  status: "payin_pending",
  // ... standard fields
}
```

**Note:** `fees.vitaRateMarkup` is kept in the schema for backward compatibility and historical records, but is **always 0** for new transactions.

---

## 4. Quote Lifecycle

### 4.1 Quote freshness

```
Quote generated → valid for 60 seconds
User edits amount → new quote, timer resets
User clicks Continuar → quote locked in frontend state
User arrives at Step 2 → quote re-validated with backend
If > 60s stale → warning shown, user must refresh
User clicks Confirmar in Step 2 → backend re-validates
If still valid → Transaction created with locked amounts
```

### 4.2 What happens if rate changes between Step 2 and Step 3

- Step 3 does NOT recalculate amounts
- The amounts locked at Transaction.create time are final
- Vita payout uses the `digitalAssetAmount` (USDC) stored
- Vita applies its current rate at execution time
- Any drift is absorbed as Alyto's spread/profit margin (no user impact)

### 4.3 Sandbox vs Production

**Sandbox (staging):**
- Vita doesn't return real IPN on `payout_completed`
- Backend auto-completes transaction after 30 seconds
- All amounts are as quoted — no Vita drift

**Production:**
- Vita executes at live rate
- User receives `destinationAmount` as stored (no post-execution adjustment)
- If Vita delivers more/less: Alyto absorbs the delta

---

## 5. Status Transitions

```
┌─────────────────┐
│  payin_pending  │  ← Transaction created, awaiting user bank transfer
└────────┬────────┘
         │ User uploads proof → Admin reviews
         ↓
┌─────────────────┐
│ payin_confirmed │  ← Admin approved the proof
└────────┬────────┘
         │ Backend dispatches to Vita
         ↓
┌─────────────────┐
│   processing    │  ← Vita is executing the payout
└────────┬────────┘
         │ Vita IPN: payout_sent
         ↓
┌─────────────────┐
│   payout_sent   │  ← Funds in transit to beneficiary bank
└────────┬────────┘
         │ Vita IPN: payout_completed
         ↓
┌─────────────────┐
│    completed    │  ← Final state, funds delivered
└─────────────────┘
```

Failure branches:
- Any state → `failed` (with reason in ipnLog)
- `failed` → `refunded` (admin initiates refund to user's BOB account)

---

## 6. What is Forbidden

The following are explicit anti-patterns. Code that introduces any of these is a bug:

1. ❌ Apply `vitaRateMarkup > 0` in any quote calculation
2. ❌ Show the user a rate different from `destinationAmount / originAmount`
3. ❌ Add a 4th step to the flow
4. ❌ Show USDC amounts in user-facing UI
5. ❌ Show "rate will vary" disclaimers
6. ❌ Allow transaction creation without paymentProof for manual payins
7. ❌ Recalculate `destinationAmount` after Transaction.create
8. ❌ Duplicate the calculation formula (must be a single function)
9. ❌ Reference `vitaRateMarkup` in calculation (schema field remains but value is always 0)
10. ❌ Show intermediate currencies ("BOB → USDC → COP")

---

## 7. Change Protocol

Any modification to this document requires:

1. Update `docs/CHANGELOG_FLOWS.md` with:
   - Reason for change
   - Who requested it
   - Impact analysis
2. Update this document (increment version)
3. Code changes must reference the new spec version
4. E2E tests updated to match new spec

Do not change the code without changing the spec first.

---

## 8. Test Fixtures

These fixtures MUST pass. If any fails, the implementation is out of spec.

### Fixture 1 — Simple BOB → COP
```
Input:    635 BOB, Colombia
Corridor: bo-co (alytoCSpread=2, fixedFee=5, profitRetention=1)
Rates:    bobPerUsdc=9.31, vitaUsdCop=4201.32

Expected output:
  totalDeducted:      17.70 BOB
  totalDeductedReal:  24.05 BOB
  usdcTransit:        65.62 USDC
  destinationAmount:  275,698.64 COP  (±1 for rounding)
  effectiveRate:      434.17 COP/BOB
```

### Fixture 2 — Minimum amount
```
Input:    300 BOB, Colombia (corridor minimum)
Expected: Valid quote, no error
```

### Fixture 3 — Below minimum
```
Input:    299 BOB, Colombia
Expected: Error "Monto mínimo: 300 BOB"
```

### Fixture 4 — No markup verification
```
Calculate quote for any corridor.
Verify: vitaRateMarkup = 0 in the calculation chain
Verify: destinationAmount = netBOB × vitaRate (no shave)
```

---

## Signatures

This spec was ratified on April 2026 for Alyto Wallet V2.0.
Next review: upon ASFI approval for AV Finance SRL (Bolivia PSAV licensing).