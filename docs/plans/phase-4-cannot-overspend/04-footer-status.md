# Task 4 — Footer: wallet state and today's spend

## 1. Where this task sits

- **Phase 4 The wallet cannot overspend** — the visibility half: the user can
  see the wallet is armed and what it has spent today.
- **This task hardens R-7 Enforce a spending policy and keep a payment
  ledger** by surfacing its state.
- **Starts after**: Tasks 2–3 (totals exist). **Waits on it**: nothing; it
  closes the phase.

## 2. What the developer needs to know

**Read first**

- `src/preferred-providers.ts` — `updatePreferredProviderStatus` and how the
  footer status is set and cleared (the pattern to follow).
- `index.ts` — the lifecycle events that call it (`session_start`,
  `before_agent_start`, `model_select`, `session_shutdown`).
- `src/x402/payments.ts` — the per-session state and daily total.

**Settled**

- Interactive mode only; nothing emitted in print, JSON, or RPC modes (the
  preferred-provider status already follows this rule).
- The footer shows, at most: wallet armed (short address), today's spend vs
  the daily ceiling. No key material, ever.
- Refusals notify once per reason per session via `ctx.ui.notify` (warning),
  not on every occurrence.

**Edges and seam**

- Touches `src/x402/payments.ts` (status formatter), `index.ts` (lifecycle
  wiring), tests for the formatter.
- Seam: a pure `paymentStatusText(state, todayTotal)` function; UI wiring
  mirrors the existing status code.

**Run**

- `npm test`, then `npm run typecheck`.

**Unknowns**

- The exact footer API surface the existing code uses — copy it, don't
  invent.

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Write the failing test: the formatter renders address and daily fraction.
3. Implement the formatter and the lifecycle wiring. Green.
4. Add cases: no wallet (no status), zero spend, over-ceiling rendering.
5. Run the suite and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | armed wallet, 0.0312 spent of 5.00 ceiling | text names the short address and `$0.0312 / $5.00 today` | `paymentStatusText` |
| 2 | no wallet configured | no status text (undefined) | `paymentStatusText` |
| 3 | spend at the ceiling | the text still renders, marked at-cap | `paymentStatusText` |
| 4 | address rendering | `0x7E5F…5Bdf` short form, never more | `paymentStatusText` |
