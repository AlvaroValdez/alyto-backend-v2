# Changelog — Flows

Curated log of user-flow-level changes. The spec documents (`docs/SEND_MONEY_FLOW.md`, etc.) are the contract; this file records which commits implemented or amended that contract and why.

## Send Money Flow v1.0 — 2026-04-22

Canonical contract: [`docs/SEND_MONEY_FLOW.md`](docs/SEND_MONEY_FLOW.md)

Unifies every quote-calculation site behind a single `calculateQuote` module and retires the `vitaRateMarkup` configuration knob so pricing in prod matches the pricing the spec describes.

| Commit    | Scope    | Summary                                                                           |
|-----------|----------|-----------------------------------------------------------------------------------|
| `a321039` | docs     | Publish SEND_MONEY_FLOW.md v1.0 — canonical contract                              |
| `df0b216` | feat     | `quoteCalculator` module — single source of truth for cross-border quotes         |
| `3b191f3` | refactor | Collapse every ad-hoc quote calculation into `calculateQuote`; zero out markup    |
| `1059997` | test     | Golden-fixture tests for `quoteCalculator` (spec §8)                              |
| `ef066c2` | script   | `migrate-remove-vita-markup` — normalize any legacy non-zero markup to 0          |

**What changed, concretely:**
- `calculateQuote(...)` is now the only function that derives a cross-border quote. Every controller, job and admin route that previously ran its own arithmetic was rewritten to call it.
- The `vitaRateMarkup` setting is no longer honored; the migration script backfills existing rows to 0 so audit trails stay consistent.
- Spec §8 golden fixtures were converted into tests. Running `npm test -- tests/quoteCalculator.test.js` is the fast signal that the calculator still matches the contract.
- No user-facing field names changed. Prior consumers that read `quote.destinationAmount`, `quote.commission`, `quote.exchangeRate` continue to work as before; the numbers they return are now deterministic from a single code path.

**Frontend counterpart:** the matching 3-step flow ships in `alyto-frontend-v2` commits `460bd9b`, `fff63bf`, `fc8d4a3`.

### Amendment — 2026-04-22 · Drop `PAYMENT_PROOF_REQUIRED` from create

| Commit    | Scope | Summary                                                                                              |
|-----------|-------|------------------------------------------------------------------------------------------------------|
| `336f9fe` | fix   | `initCrossBorderPayment` no longer requires `paymentProofBase64`. Proof is uploaded in Step 3 via `POST /payments/:txId/comprobante` (`uploadPaymentProof`), which already persists `Transaction.paymentProof`, logs `payment_proof_uploaded` on `ipnLog`, and broadcasts `tx_actionable`. |

Originally (commit `eafca09`) the SRL branch rejected requests without `paymentProofBase64` so that `Accionables` would never get a tx with no way to verify. Under the canonical SendMoney contract (SEND_MONEY_FLOW.md §2.2/§2.3) that gate must move to Step 3 — Step 2 is the point at which the user confirms the details and the tx must persist in `payin_pending` so the bank reference (`alytoTransactionId`) can be shown on Step 3. The gate was removed from both the CL→BO branch and the main SRL flow; the duplicate initial broadcast was deleted so `broadcastToAdmins` fires exclusively from `uploadPaymentProof`. **Frontend counterpart:** `alyto-frontend-v2` commits `d5cf312` + `737223d`.
