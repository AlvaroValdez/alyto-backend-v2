# CHANGELOG_FLOWS.md

> Change log for all canonical flow specifications.
> **Any change to a flow spec must be logged here BEFORE modifying code.**

---

## Format

```
## YYYY-MM-DD — [Flow Name] v[X.Y]
**Requested by:** [person]
**Reason:** [why the change is necessary]
**Impact:** [what parts of the system are affected]
**Spec changes:** [high-level bullet list]
**Code changes:** [commit hashes after implementation]
```

---

## 2026-04-22 — Send Money Flow v1.0 (INITIAL)

**Requested by:** Alvaro Valdez (Founder)
**Reason:** Previous flow had 5 steps with inconsistent calculations between quote and execution (0.39% drift), causing user confusion in Bolivia. Multiple iterations to fix individual issues created fragmentation.

**Impact:**
- Frontend: full rewrite of SendMoney flow from 5 to 3 steps
- Backend: unified calculation formula in `calculateBOBQuote` and `quoteSocket.js`
- Schema: `vitaRateMarkup` field kept but always 0 for new transactions
- UX: progressive disclosure (simple by default, details on expand)

**Spec changes:**
- Established 5 inviolable design principles
- Defined exactly 3 navigation steps
- Removed `vitaRateMarkup` from calculation chain
- Specified single unified calculation formula
- Defined display rules for currencies
- Listed 10 forbidden anti-patterns
- Added test fixtures

**Code changes:** [to be filled after implementation commits]
