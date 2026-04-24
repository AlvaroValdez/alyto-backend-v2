# OwlPay Harbor — Sandbox E2E Test Procedure

> Last updated: April 2026  
> Based on: confirmation from Sam (OwlPay) 2026-04-23  
> Docs: https://harbor-developers.owlpay.com/docs/simulate-transfer-status-apis

---

## Sandbox environment facts (confirmed)

- **Webhook secret:** `whs_eprwSys6Adl5zZbU` → set as `OWLPAY_WEBHOOK_SECRET` in `.env`
- **Signature header:** `harbor-signature: t=<timestamp>,v1=<hmac_hex>`
- **Beneficiary data:** use valid-format fake data — if a field requires 4-digit postal code, use `"1234"` not `"12345"`
- **USDC:** Harbor issues a Stellar **testnet** `instruction_address` — send real testnet USDC to it
- **No actual fiat payout** happens in sandbox — Harbor only simulates the webhook events
- **Simulate endpoint:** `POST /api/v1/transfers/{uuid}/simulate-completed`

---

## Prerequisites

```env
OWLPAY_BASE_URL=https://harbor-sandbox.owlpay.com/api
OWLPAY_WEBHOOK_SECRET=whs_eprwSys6Adl5zZbU
OWLPAY_CUSTOMER_UUID_SRL=<uuid from Harbor dashboard>
OWLPAY_USDC_SEND_ENABLED=0    # Test 1 (manual) — change to 1 for Test 2
NODE_ENV=development           # NOT production — sandbox route is guarded
STELLAR_NETWORK=testnet
```

---

## Test 1 — OWLPAY_USDC_SEND_ENABLED=0 (manual USDC send)

This tests the bo-cn or bo-ng corridor with admin-triggered USDC send.

**Steps:**

1. Create an SRL transaction for corridor `bo-cn`, ~300 BOB
2. Admin approves payin in Ledger → `status: payin_confirmed`
3. `dispatchPayout` fires → `tryOwlPayV2`:
   - `getHarborQuote` → POST /v2/transfers/quotes
   - `getHarborTransferRequirements` → GET /v2/transfers/quotes/{id}/requirements
   - `createHarborTransfer` → POST /v2/transfers
   - Response contains `instruction_address` + `instruction_memo`
   - `status → payout_pending_usdc_send` (OWLPAY_USDC_SEND_ENABLED=0)
   - Admin receives email with manual USDC send instruction

4. **Verify logs:** confirm `instruction_address`, `instruction_memo`, Harbor `transferId` are stored in `Transaction.harborTransfer`

5. **Manual USDC send:** send testnet USDC to `instruction_address` from your Stellar testnet wallet

6. **Trigger simulate:**
   ```bash
   curl -X POST https://alyto-backend-v2.onrender.com/api/v1/admin/sandbox/owlpay/simulate/{transferId} \
     -H "Authorization: Bearer <admin_token>"
   ```
   Or locally:
   ```bash
   curl -X POST http://localhost:3000/api/v1/admin/sandbox/owlpay/simulate/{transferId} \
     -H "Authorization: Bearer <admin_token>"
   ```

7. **Harbor fires webhook:** `transfer.completed` → `handleOwlPayIPN`
   - `status → completed`
   - `recordSent(contactId, ...)` fires if contactId is set
   - Stellar audit trail registered
   - User push notification sent

8. **Verify:**
   - `Transaction.status === 'completed'`
   - `Transaction.completedAt` set
   - `Transaction.stellarTxId` populated (testnet explorer)
   - User received push + email

---

## Test 2 — OWLPAY_USDC_SEND_ENABLED=1 (automatic Stellar send)

Same as Test 1, but step 5 is automated.

**Steps 1–4:** identical to Test 1

5. `sendUSDCToHarbor` fires automatically:
   - `stellarService.sendUSDCToHarbor` → payment from `STELLAR_SRL_PUBLIC_KEY` to `instruction_address`
   - Stellar testnet hash stored in `Transaction.stellarTxHash`
   - `status → payout_pending_usdc_send` → after Stellar confirm → Harbor detects USDC arrival

6. **Check for `transfer.source_received` webhook:**
   - `status → payout_sent`
   - User push: "Pago en proceso"

7. **Trigger simulate-completed:**
   ```bash
   curl -X POST http://localhost:3000/api/v1/admin/sandbox/owlpay/simulate/{transferId} \
     -H "Authorization: Bearer <admin_token>"
   ```

8. **Same verification as Test 1 step 8**

---

## Key code locations

| Piece | File | Function |
|-------|------|----------|
| Harbor transfer creation | `src/controllers/ipnController.js` | `tryOwlPayV2` |
| Simulate endpoint call | `src/services/owlPayService.js` | `simulateTransferCompleted` |
| Webhook handler | `src/controllers/ipnController.js` | `handleOwlPayIPN` |
| Admin sandbox route | `src/routes/adminRoutes.js` | `POST /sandbox/owlpay/simulate/:transferId` |
| Signature verification | `src/services/owlPayService.js` | `verifyWebhookSignature` |

---

## Common failure modes

| Symptom | Likely cause |
|---------|-------------|
| `401 Firma inválida` on webhook | `OWLPAY_WEBHOOK_SECRET` wrong or `rawBody` not preserved — check `app.use(express.json({ verify: ... }))` |
| `payout_pending_usdc_send` but no email | Admin email template missing or `sendEmail` failed — check logs |
| Simulate returns 403 | `NODE_ENV=production` — use `development` or `staging` |
| Simulate returns 500 | `isSandbox()` check failed — verify `OWLPAY_BASE_URL` contains "sandbox" |
| Transaction stuck at `payin_confirmed` | `tryOwlPayV2` threw — check Sentry + logs for Harbor API error |
