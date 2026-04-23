# Send Money Flow — Living Document

> Last updated: April 2026  
> This documents **actual working code**, not aspirational spec.  
> Update this file whenever the flow changes.  
> Both repos (`alyto-backend-v2` and `alyto-frontend-v2`) carry an identical copy.

---

## 1. Overview

Alyto supports three legal entities. The send-money flow varies by `user.legalEntity`:

| Entity | Origin currency | Payin | Payout routing |
|--------|----------------|-------|----------------|
| **SpA** (Chile) | CLP | Fintoc A2A (PISP) | Vita Wallet (LatAm) / anchorBolivia (BOB) |
| **SRL** (Bolivia) | BOB | Manual: QR scan or bank transfer | Vita Wallet (LatAm) / OwlPay Harbor (CNY/NGN) |
| **LLC** (USA) | USD | Manual: wire transfer | OwlPay Harbor (global) |

SRL and LLC auto-skip Step 2 because their payin method is always `manual`.

---

## 2. Frontend — Step Structure

### Hook: `src/hooks/useSendMoney.js`

```
TOTAL_STEPS = 6
State shape: { step: Number, stepData: Object }
```

`stepData` is built **cumulatively** — each `onNext(data)` merges `data` into the existing state.

Key methods:
- `nextStep(data, targetStep?)` — advances (or jumps to `targetStep`) and merges data
- `prevStep()` — if `step === 3 && stepData._skipStep2` → jumps back to step 1, not step 2
- `submitPayment(payload)` — thin wrapper around `initPayment()` that captures exceptions in Sentry before re-throwing

---

### SpA Flow (Chile)

```
Step 1: Amount + destination country
  │  onNext({ originAmount, destinationCountry, quote })
  ↓
Step 2: Payin method (Fintoc)
  │  onNext({ payinMethod: 'fintoc' })
  ↓
Step 3: Beneficiary form
  │  onNext({ beneficiaryData, contactId })
  ↓
Step 4: Confirmation → POST /payments/crossborder
  │  onNext({ transactionId, payinUrl, payinInstructions, paymentQR, paymentQRStatic })
  ↓
Step 5: Fintoc widget (new tab) + polling every 5s
  │  onNext({ completedAt })
  ↓
Step 6: Success screen
```

### SRL Flow (Bolivia)

```
Step 1: Amount + destination country
  │  onNext({ originAmount, destinationCountry, quote })
  ↓
  [Step2 useEffect fires on mount → legalEntity === 'SRL' → auto-skip]
  │  onNext({ payinMethod: 'manual', _skipStep2: true })  ← jumps to step 3
  ↓
Step 3: Beneficiary form
  │  onNext({ beneficiaryData, contactId })
  ↓
Step 4: Confirmation → POST /payments/crossborder
  │  onNext({ transactionId, payinInstructions, paymentQR, paymentQRStatic })
  ↓
Step 5: Manual payment screen
  │  → Static QR images (from SRLConfig admin panel)
  │  → Dynamic QR (bank data encoded by backend)
  │  → Bank account card (AV Finance SRL / Banco Bisa)
  │  → Upload comprobante → POST /payments/:txId/comprobante
  │  → Navigates to /transactions/:txId  (no polling — admin confirms manually)
  ↓
Step 6: Success (or user waits at /transactions while admin confirms)
```

---

## 3. `stepData` — Complete Shape

```js
{
  // ── Step 1: Step1Amount.jsx ────────────────────────────────────────────
  originAmount:       Number,         // e.g. 100000 (integer CLP or BOB)
  destinationCountry: String,         // ISO-2, e.g. 'CO', 'PE', 'AR'
  quote: {
    corridorId:          String,      // e.g. 'cl-co', 'bo-cn'
    originCurrency:      String,      // 'CLP' | 'BOB' | 'USD'
    destinationCurrency: String,      // 'COP', 'PEN', 'ARS', 'CNY', ...
    destinationAmount:   Number,
    exchangeRate:        Number,      // effective rate (net of fees)
    estimatedDelivery:   String,      // e.g. '1 día hábil'
    fees: {
      alytoCSpread:  Number,          // spread % applied on origin amount
      fixedFee:      Number,          // flat fee in origin currency
      payinFee:      Number,          // Fintoc/processing fee
      payoutFee:     Number,          // Vita/Harbor payout fee
      // profitRetention: NEVER exposed to frontend
    },
    usdcTransitAmount: Number | null, // BOB corridors only — USDC in-flight (Stellar audit)
  },

  // ── Step 2: Step2PayinMethod.jsx ──────────────────────────────────────
  payinMethod:  String,  // 'fintoc' | 'manual'
  payinVariant: String,  // 'qr' | 'manual' — UI-only distinction for BO (Step5 QR vs text)
  _skipStep2:   Boolean, // true when SRL/LLC auto-skipped

  // ── Step 3: Step3Beneficiary.jsx ─────────────────────────────────────
  beneficiaryData: {
    // Dynamic fields from GET /payments/withdrawal-rules/:countryCode
    // Keys vary by corridor. Common Vita keys:
    fullName:         String,
    documentType:     String,
    documentId:       String,
    bankName:         String,
    accountNumber:    String,
    accountType:      String,
    // fc_* keys (internal Vita fields) are stripped on submit — NOT sent to backend
  },
  contactId: String | null,           // _id of saved Contact, if user picked from picker

  // ── Step 4: Step4Confirm.jsx (response from initCrossBorderPayment) ──
  transactionId:     String,          // e.g. 'ALY-B-1714000000000-ABC123'
  payinUrl:          String | null,   // Fintoc widget URL (SpA only)
  payinMethod:       String,          // backend may override if different from request
  payinInstructions: Object | null,   // bank details for manual payin (SRL/LLC)
  paymentQR:         String | null,   // dynamic QR base64 (SRL)
  paymentQRStatic:   Array,           // admin-uploaded QRs: [{ label, imageBase64 }]

  // ── Step 6 ────────────────────────────────────────────────────────────
  completedAt: String,                // ISO timestamp (from polling response)
}
```

---

## 4. Step Details

### Step 1 — `Step1Amount.jsx`

- **Origin currency by entity:** `SpA→CLP`, `LLC→USD`, `SRL→BOB` (constant `ENTITY_ORIGIN`)
- **Available countries:** loaded dynamically from `GET /api/v1/payments/corridors`, filtered by user's `legalEntity`. 26 destinations across LatAm + Global.
- **Country picker:** bottom-sheet modal with flag images (`flagcdn.com/w80/{code}.png`) and free-text search.
- **Real-time quote:** `useQuoteSocket(rawAmount, countryCode)` — WebSocket connection that updates on amount/country change.
- **BOB rate display:** SRL corridors additionally fetch `getCurrentExchangeRates()` to show the BOB/USDT rate (`ExchangeRate` model). Stale badge if rate is >24h old.
- **`canContinue`:** requires `quote` present + WebSocket status not in `['connecting', 'expired', 'disconnected', 'error']` + non-zero amount + selected country.
- **`onNext` payload:** `{ originAmount: rawAmount, destinationCountry: selectedCountry.code, quote }`

### Step 2 — `Step2PayinMethod.jsx`

- **Auto-skip trigger:** `useEffect` fires on component mount. If `user.legalEntity === 'SRL' || user.legalEntity === 'LLC'` → calls `onNext({ payinMethod: 'manual', _skipStep2: true })` immediately, skipping to step 3.
- **CL methods:** Only `fintoc` has `available: true`. All others show "Próximamente".
- **BO methods (UI only — SRL never reaches this):** Two options — `qr` (Pago con QR) and `manual` (Transferencia bancaria). Both map to `payinMethod: 'manual'` for the backend; visual variant stored in `payinVariant`.
- **Other origin countries** (AR, CO, BR, MX): All `available: false`.
- **`onNext` payload:** `{ payinMethod, payinVariant: selected.id }`

### Step 3 — `Step3Beneficiary.jsx`

- **Dynamic form:** fields loaded from `GET /api/v1/payments/withdrawal-rules/:countryCode`. Works for both Vita (vitaWallet) and OwlPay (owlPay) corridors — the backend normalizes both to the same `{ fields }` array.
- **ContactPicker:** horizontal chip row above the form. Shows saved contacts for `destinationCountry` via `useContacts(destinationCountry)`. Selecting a chip pre-fills `values` from `contact.beneficiaryData` and sets `contactId`. Hides once a contact is selected (shows prefill banner instead).
- **Prefill from Contacts page:** `sessionStorage.getItem('alyto_prefill_contact')` is read on mount. Cleared immediately after reading.
- **`fc_*` fields:** hidden from UI, stripped from `beneficiaryData` before `onNext` — backend adds them from corridor config.
- **Conditional fields:** `field.when = { key, value }` — field renders only when the referenced field has the expected value.
- **Save-as-contact toggle:** non-blocking `createContact()` call. Uses `payoutMethod` from `useWithdrawalRules` to set `formType`: `owlPay → 'owlpay'`, otherwise `→ 'vita'`.
- **`onNext` payload:** `{ beneficiaryData, contactId }` — `contactId` is `null` if no saved contact was used.

### Step 4 — `Step4Confirm.jsx`

- **Fees shown:** `costoEnvio = alytoCSpread + fixedFee + payinFee + payoutFee`. `profitRetention` is **never shown**.
- **Breakdown:** expandable chevron shows `comisionServicio` (alytoCSpread + fixedFee) and `feeProcesamiento` (payinFee + payoutFee).
- **Confirmation checkbox:** required before "Confirmar y pagar" button activates.
- **API call:** `POST /api/v1/payments/crossborder` via `initPayment()`.
- **Session save:** `sessionStorage.setItem('lastTransactionId', res.transactionId)` — for PaymentSuccessPage redirect target after Fintoc.
- **`onNext` payload:** the full response from `initCrossBorderPayment` (see §6 below).

**Request payload sent to backend:**
```js
{
  corridorId:        quote.corridorId,
  originAmount,                        // Number
  payinMethod,
  beneficiaryData,                     // dynamic field object
  destinationAmount: quote.destinationAmount,   // denormalized for traceability
  exchangeRate:      quote.exchangeRate,        // denormalized
  contactId,                           // String | omitted if null
}
```

### Step 5 — `Step5PaymentWidget.jsx`

**Branch `payinMethod === 'manual'` → `ManualPayinScreen`:**
- Shows static QR images uploaded by admin (`paymentQRStatic[]` — Tigo Money, Banco Bisa, etc.)
- Shows dynamic QR base64 (`paymentQR`) — only if no static QRs
- If neither is available: fetches `GET /payments/:txId/qr` lazily
- Bank account card: Banco, Titular, Cuenta, Tipo, Monto + copyable reference ID
- Upload comprobante: `POST /payments/:txId/comprobante`, field name: `comprobante`, max 5MB, JPG/PNG/PDF
- After successful upload: navigates to `/transactions/:txId`
- **No polling** — admin confirms manually in the Ledger panel

**Branch `payinMethod !== 'manual'` → `PollingPayinScreen`:**
- Opens `payinUrl` in new tab (`window.open`)
- Polls `GET /api/v1/payments/:txId/status` every **5 seconds**
- Final statuses that stop polling: `payin_confirmed`, `payin_completed`, `completed`, `in_transit`
- Timeout: **15 minutes** — shows support contact screen if reached
- If `payinUrl` is null: shows error with support email link

---

## 5. Frontend Services Map

| Function | File | Description |
|----------|------|-------------|
| `initPayment(payload)` | `paymentsService.js` | `POST /api/v1/payments/crossborder` |
| `uploadComprobante(txId, file)` | `paymentsService.js` | `POST /api/v1/payments/:txId/comprobante` |
| `getTransactionStatus(txId)` | `paymentsService.js` | `GET /api/v1/payments/:txId/status` |
| `getPaymentQR(txId)` | `paymentsService.js` | `GET /api/v1/payments/:txId/qr` (lazy load) |
| `listUserCorridors()` | `paymentsService.js` | `GET /api/v1/payments/corridors` |
| `getCurrentExchangeRates()` | `paymentsService.js` | `GET /api/v1/exchange-rates/current` |
| `createContact(data)` | `api.js` | `POST /api/v1/contacts` |
| `useQuoteSocket(amount, country)` | `hooks/useQuoteSocket.js` | WebSocket real-time quote |
| `useWithdrawalRules(countryCode)` | `hooks/useWithdrawalRules.js` | Dynamic form fields + payoutMethod, cached 30min in sessionStorage |
| `useContacts(country?)` | `hooks/useContacts.js` | Saved contacts, filtered by country if provided |

---

## 6. Backend — Transaction Lifecycle

### `POST /api/v1/payments/crossborder` → `initCrossBorderPayment`

**Required fields:** `corridorId`, `originAmount`, `beneficiaryData` (or legacy `beneficiary`)

**Validations:**
- Corridor must be active in `TransactionConfig`
- User's `legalEntity` country must match `corridor.originCountry`
- `originAmount` must be within `corridor.minAmountOrigin` / `maxAmountOrigin`
- SRL/BOB: hard cap at **Bs 49,999** per transaction (ASFI RND 102400000021 compliance)

**Transaction ID format:** `ALY-{routingScenario}-{Date.now()}-{random6chars}`
- SpA (routingScenario B): `ALY-B-1714000000000-ABC123`
- SRL (routingScenario C): `ALY-C-1714000000000-ABC123`
- LLC (routingScenario A): `ALY-A-1714000000000-ABC123`

**Branch: `corridor.payinMethod === 'fintoc'` (SpA standard LatAm)**
```
→ Call Vita createPayin() → get payment_order URL
→ Transaction.create({ status: 'payin_pending', payinProvider: 'vitaWallet' })
→ Response: { transactionId, payinUrl, payinMethod: 'vitaWallet', status: 'payin_pending' }
```

**Branch: `corridor.destinationCurrency === 'BOB' && corridor.payoutMethod === 'anchorBolivia'` (CL→BO)**
```
→ Lookup SpAConfig for bank details
→ Transaction.create({ status: 'payin_pending', payinProvider: 'manual' })
→ Generate dynamic QR
→ Read SRLConfig for static QRs
→ Response: { transactionId, paymentInstructions, paymentQR, paymentQRStatic, status: 'payin_pending' }
```

**Branch: `corridor.payinMethod === 'manual'` (SRL, LLC)**
```
→ Transaction.create({ status: 'payin_pending', payinProvider: 'manual' })
→ Generate dynamic QR (encodes bank data for banking apps)
→ Read SRLConfig for static QRs (Tigo Money, Banco Bisa, etc.)
→ Response: { transactionId, paymentInstructions, paymentQR, paymentQRStatic, status: 'payin_pending' }
```

**Side effects on all branches:**
- Email to user (payment initiated / manual instructions)
- Push notification to user (`transferInitiated`)
- `notifyAdmins` — push + in-app
- Admin email `adminBoliviaAlert` if `payinMethod === 'manual'`

---

### `POST /api/v1/payments/:transactionId/comprobante` → `uploadPaymentProof`

- Multer field: **`comprobante`** | Limit: 5MB | Types: JPG, PNG, PDF
- Only allowed if `transaction.paymentInstructions != null` (i.e. manual payin flows)
- Persists `Transaction.paymentProof` (buffer as base64 + metadata)
- Appends to `transaction.ipnLog` (`eventType: 'payment_proof_uploaded'`)
- **Fires `broadcastToAdmins('tx_actionable')`** — triggers SSE notification in admin Ledger tab
- Sends `notifyAdmins(adminPaymentProof)` — push + in-app
- **Does NOT change transaction status** — admin confirms in Ledger

---

### `dispatchPayout(transaction)` — Fire-and-Forget

Called from IPN handlers without `await`. Routing decision reads `corridor.payoutMethod`:

```
1. if corridor.payoutMethod === 'owlPay' && legalEntity ∈ { SRL, LLC }
   → tryOwlPayV2(transaction, corridor, netAmountUSD)
     → Harbor: getQuote → getRequirements → createTransfer
     → If OWLPAY_USDC_SEND_ENABLED=1: sendUSDCToHarbor (Stellar → Harbor instruction_address)
     → If OWLPAY_USDC_SEND_ENABLED=0 (current default): status = 'payout_pending_usdc_send'
                                                          email admin with manual USDC send instruction
     → On success: status = 'payout_sent', waits for Harbor webhook

2. else if corridor.payoutMethod ∈ { vitaWallet, owlPay } (vitaWallet branch)
   → if destCountry ∈ VITA_SENT_ONLY_COUNTRIES { GT, SV, ES, PL }:
       createVitaSentPayout(vitaPayload)
   → else:
       createPayout(vitaPayload)
   → On success: status = 'payout_sent'

3. else if corridor.payoutMethod === 'anchorBolivia'
   → Append ipnLog, set status = 'payout_pending'
   → Email admin Bolivia alert with beneficiary details
   → STOP — admin executes manual BOB bank transfer
```

**Sandbox mode:** When `VITA_ENVIRONMENT === 'sandbox'`, after `payout_sent` a 4-second timer fires that sets `status = 'completed'` and fires `recordSent()`.

**Production Vita flow:** After `payout_sent`, waits for a second Vita IPN (`vitaStatus === 'completed'`) to transition to `status = 'completed'`.

---

### IPN Handlers

| Handler | Trigger | Transition |
|---------|---------|------------|
| `handleFintocIPN` | `POST /api/v1/payments/webhooks/fintoc-crossborder` — `payment_intent.succeeded` | `payin_pending → payin_confirmed → dispatchPayout` |
| `handleVitaIPN` (payin) | `POST /api/v1/ipn/vita` — `vitaStatus: 'completed'` when `currentStatus ∈ { payin_pending, initiated }` | `payin_pending → payin_confirmed → dispatchPayout` |
| `handleVitaIPN` (payout) | Same endpoint — `vitaStatus: 'completed'` when `currentStatus === 'payout_sent'` | `payout_sent → completed` + recordSent |
| `handleOwlPayWebhook` — `transfer.source_received` | `POST /api/v1/payments/webhooks/owlpay` | `* → payout_sent` |
| `handleOwlPayWebhook` — `transfer.completed` | Same endpoint | `payout_sent → completed` + recordSent |

**`recordSent(contactId, destinationAmount, destinationCurrency)`:** fire-and-forget (`.catch(() => {})`) — updates `Contact.lastUsedAt` + `Contact.totalSent`. Never blocks the payment flow.

---

## 7. Status State Machine

```
payin_pending                    ← Created by initCrossBorderPayment (all paths)
  │
  ├─ payin_confirmed             ← Fintoc IPN payment_intent.succeeded
  │    └─→ dispatchPayout()          or Vita IPN completed (payin)
  │                                  or Admin manual confirmation (Ledger)
  │
  ├─ failed                      ← Vita IPN vitaStatus: 'denied'
  │
  └─ [user uploads comprobante   ← No status change — admin confirms
       → broadcastToAdmins]

payin_confirmed
  │
  └─ [dispatchPayout runs]
       │
       ├─ payout_sent            ← Vita/Harbor accepted the payout request
       │    ├─ completed         ← Vita 2nd IPN: 'completed' / Harbor: transfer.completed
       │    └─ failed            ← tryOwlPayV2 exception
       │
       ├─ payout_pending_usdc_send  ← OwlPay: Harbor transfer created, manual USDC send needed
       │    └─ payout_sent       ← Harbor: transfer.source_received
       │
       ├─ pending_funding        ← OwlPay: FundingRecord USDC insufficient
       │
       ├─ payout_pending         ← anchorBolivia: admin notified, manual BOB transfer pending
       │
       └─ processing             ← Unimplemented payoutMethod (fallback — no external call)
```

**Polling stops at:** `payin_confirmed`, `payin_completed`, `completed`, `in_transit`

---

## 8. Quote Formula — `src/services/quoteCalculator.js`

> Only entry point for BOB quote math. All callers (HTTP quote endpoint, WebSocket branch 2) **must** call `calculateQuote()` — no duplicated math.

**Inputs:** `{ amount, corridor, bobPerUsdc, vitaRate }`

```
Step 1 — fees in origin currency (BOB)
  payinFee        = amount × (corridor.payinFeePercent / 100)
  alytoCSpread    = amount × (corridor.alytoCSpread / 100)
  fixedFee        = corridor.fixedFee
  profitRetention = amount × (corridor.profitRetentionPercent / 100)

Step 2 — user-facing fees
  visibleFees  = payinFee + alytoCSpread + fixedFee
  totalDeducted = round2(visibleFees)

Step 3 — internal total (adds hidden retention)
  totalDeductedReal = round2(visibleFees + profitRetention)

Step 4 — net BOB for conversion
  netBOB = amount - totalDeductedReal

Step 5 — USDC transit (Stellar audit; never shown to user)
  usdcTransitAmount = round2(netBOB / bobPerUsdc)
  digitalAsset = 'USDC'

Step 6 — destination amount (raw Vita rate, vitaRateMarkup always = 0)
  payoutFeeInDest   = corridor.payoutFeeFixed × vitaRate
  destinationAmount = round2((usdcTransitAmount × vitaRate) - payoutFeeInDest)

Step 7 — effective rate for display
  effectiveRate = round2(destinationAmount / amount)
```

**Returns:** `{ originAmount, totalDeducted, destinationAmount, effectiveRate, totalDeductedReal, fees{}, conversionRate{}, digitalAssetAmount, digitalAsset }`

**Key invariants:**
- `vitaRateMarkup` is always 0 — spec §3.5 / §6.9
- `profitRetention` appears in `Transaction.fees` for audit but is **never** in the frontend response or Step4 display
- `usdcTransitAmount` is passed in `stepData.quote.usdcTransitAmount` and preserved in `Transaction.digitalAssetAmount` to avoid recalculation at payout time

**Verified example:** Transaction `ALY-C-1776716247117-TCWE77` — 1000 BOB → COP

---

## 9. Active Corridors (April 2026)

### SpA — Chile (CLP origin)

| Corridor ID | Destination | Dest currency | Payout provider |
|-------------|-------------|---------------|-----------------|
| cl-co | Colombia | COP | Vita Wallet |
| cl-pe | Perú | PEN | Vita Wallet |
| cl-ar | Argentina | ARS | Vita Wallet |
| cl-mx | México | MXN | Vita Wallet |
| cl-br | Brasil | BRL | Vita Wallet |
| cl-bo | Bolivia | BOB | anchorBolivia (SRL manual) |
| cl-uy | Uruguay | UYU | Vita Wallet |
| cl-py | Paraguay | PYG | Vita Wallet |
| cl-ec | Ecuador | USD | Vita Wallet |
| cl-ve | Venezuela | USD | Vita Wallet |
| cl-us | EE.UU. | USD | Vita Wallet |
| cl-gt | Guatemala | GTQ | Vita (vitaSent) |
| cl-sv | El Salvador | USD | Vita (vitaSent) |
| cl-cr | Costa Rica | CRC | Vita Wallet |
| cl-pa | Panamá | USD | Vita Wallet |
| cl-do | R. Dominicana | DOP | Vita Wallet |

### SRL — Bolivia (BOB origin)

| Corridor ID | Destination | Dest currency | Payout provider |
|-------------|-------------|---------------|-----------------|
| bo-co | Colombia | COP | Vita Wallet |
| bo-pe | Perú | PEN | Vita Wallet |
| bo-ar | Argentina | ARS | Vita Wallet |
| bo-mx | México | MXN | Vita Wallet |
| bo-br | Brasil | BRL | Vita Wallet |
| bo-cl | Chile | CLP | Vita Wallet |
| bo-uy | Uruguay | UYU | Vita Wallet |
| bo-py | Paraguay | PYG | Vita Wallet |
| bo-ec | Ecuador | USD | Vita Wallet |
| bo-ve | Venezuela | USD | Vita Wallet |
| bo-us | EE.UU. | USD | Vita Wallet |
| bo-gt | Guatemala | GTQ | Vita (vitaSent) |
| bo-sv | El Salvador | USD | Vita (vitaSent) |
| bo-es | España | EUR | Vita (vitaSent) |
| bo-pl | Polonia | PLN | Vita (vitaSent) |
| bo-cr | Costa Rica | CRC | Vita Wallet |
| bo-pa | Panamá | USD | Vita Wallet |
| bo-do | R. Dominicana | DOP | Vita Wallet |
| bo-ht | Haití | HTG | Vita Wallet |
| bo-hk | Hong Kong | HKD | Vita Wallet |
| bo-ca | Canadá | CAD | Vita Wallet |
| bo-cn | China | CNY | **OwlPay Harbor** |
| bo-ng | Nigeria | NGN | **OwlPay Harbor** |

**`VITA_SENT_ONLY_COUNTRIES`** (use `createVitaSentPayout` instead of `createPayout`): `GT`, `SV`, `ES`, `PL`

### LLC — USA (USD origin)

| Corridor ID | Destination | Payout provider |
|-------------|-------------|-----------------|
| us-* (global) | Global | OwlPay Harbor |

---

## 10. Known Limitations / Deferred

| # | Item | Status |
|---|------|--------|
| 1 | BOB wallet with balance (Dual Ledger off-chain + Stellar on-chain) | Pending Phase 25 |
| 2 | Fund freezing via Stellar Trustlines (ASFI requirement) | Pending Phase 26 |
| 3 | PRILI complaint point in app | Pending Phase 27 |
| 4 | OFAC/UN/PEPs sanctions scanning | Pending Phase 28 |
| 5 | `sendUSDCToHarbor()` automatic mode (`OWLPAY_USDC_SEND_ENABLED=1`) | Pending chain confirmation with Sam (OwlPay) — currently manual |
| 6 | Payin methods for AR (Khipu/Bind), CO (PSE/Nequi), BR (PIX), MX (CLABE) | Próximamente |
| 7 | OwlPay additional corridors: AU, GB, JP, SG, ZA, AE | Pending LLC MSA activation |
| 8 | `dispatchPayout` is fire-and-forget — post-catch errors don't update status | See Phase 25+ improvement |
| 9 | BOB transaction limit is 49,999 Bs per tx while ASFI ETF/PSAV license pending | Lift once license granted |

---

## 11. Change Log

| Date | Version | Author | Change |
|------|---------|--------|--------|
| 2026-04-23 | 1.0 | Claude Code | Initial document from working code |
| 2026-04-23 | 1.1 | Claude Code | Corrections: Fintoc IPN handler (`handleFintocIPN`), status always `payin_pending` on creation, `dispatchPayout` routing from actual code (corridor.payoutMethod-based, not legalEntity+amount threshold), `contactId` added to stepData and payload, `formType` uses `payoutMethod` (vita/owlpay), `ContactPicker` inline in Step3 |
