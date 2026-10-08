# Task 2 — Enforce policy before signing; log refusals with reasons

## 1. Where this task sits

- **Phase 4 The wallet cannot overspend**.
- **This task finishes R-7's enforcement half**: per-request and per-day
  ceilings gate every signature, and every refusal is recorded with a reason.
- **Starts after**: Task 1. **Waits on it**: Task 3's ledger stores the
  refusal records this task emits.

## 2. What the developer needs to know

**Read first**

- `src/x402/pay.ts` — the decision point; refusals currently return silently.
- `src/x402/payments.ts` — where daily spend is tracked per session.
- `docs/plans/x402-fetch-hook.md` §R-7 — refusal semantics: normal errors,
  logged with reasons.

**Settled**

- Per-day ceiling counts settled payments in the current UTC day across the
  session; the running total lives in the payment state, fed by the ledger
  events from Task 3 (ordering: emit first, count from the same record).
- Refusals surface to the caller as the untouched 402 (unchanged behavior)
  plus a structured record; an optional `onRefusal` callback lets the session
  layer notify the UI.
- The refusal reasons are a closed vocabulary: `over-request-ceiling`,
  `over-day-ceiling`, `host-not-allowed`, `unsupported-challenge`,
  `unparseable-challenge`.

**Edges and seam**

- Touches `src/x402/pay.ts`, `src/x402/payments.ts`, tests.
- Seam: the `payingFetch` stub seam, asserting on recorded refusals.

**Run**

- `npm test`, then `npm run typecheck`.

**Unknowns**

- Day-boundary semantics: UTC day is the simple choice; document it in the
  ledger entry so a later local-time change is a data-visible change.

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Write the failing test: over-day-ceiling refuses with that exact reason.
3. Implement day accounting and refusal records. Green.
4. Add the remaining refusal-reason cases.
5. Run the suite and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | day total at the ceiling, one more challenge | refusal `over-day-ceiling`, signer unused | `payingFetch` |
| 2 | challenge above the request ceiling | refusal `over-request-ceiling` | `payingFetch` |
| 3 | non-allowlisted host | refusal `host-not-allowed` | `payingFetch` |
| 4 | bare 402 | refusal `unparseable-challenge` (diagnostic only; response untouched) | `payingFetch` |
| 5 | Solana-only challenge | refusal `unsupported-challenge` | `payingFetch` |
