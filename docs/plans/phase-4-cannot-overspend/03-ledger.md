# Task 3 — JSONL ledger: settled payments, refusals, X-Cost capture

## 1. Where this task sits

- **Phase 4 The wallet cannot overspend**.
- **This task finishes R-7's audit half**: every settled payment leaves a
  ledger line with a settlement hash, and refusals are logged too.
- **Starts after**: Task 2 (refusal records exist). **Waits on it**: Task 4's
  footer reads the same running totals.

## 2. What the developer needs to know

**Read first**

- `src/x402/pay.ts` — where settlement evidence appears (the
  `payment-response`/`x-payment-response` header on the paid response).
- `docs/probe-results.md` — Surp and Surplus settle via facilitator; the
  receipt header carries the transaction.
- `src/x402/payments.ts` — session state; the ledger path is per-project
  (`.pi/x402-ledger.jsonl`).

**Settled**

- Ledger entry: `{ ts, sessionId, host, path, amountAtomic, usdc, outcome,
  reason?, tx? }`; `outcome` is `settled` or `refused` (closed vocabulary).
- Ruvicode's `X-Cost` response header is captured as an observation entry
  (`outcome: "observed"`) since it costs nothing to sign for; Bu0y's
  body-carried cost is out of scope (invasive body sniffing).
- The ledger appends atomically enough for one process (appendFileSync); it
  never throws into the payment path.

**Edges and seam**

- New file `src/x402/ledger.ts` plus tests; `pay.ts` and `payments.ts` emit
  into it.
- Seam: the ledger as a pure appender over an injected writer; the stub-fetch
  tests assert the emitted events.

**Run**

- `npm test`, then `npm run typecheck`.

**Unknowns**

- Whether the paid response's receipt header name is `payment-response`
  (v2-style) or `x-payment-response` (v1-style): read both, record whichever
  appears.

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Write the failing test: a settled payment appends one JSONL line with the
   amount and tx hash.
3. Implement the ledger and the emission points. Green.
4. Add cases: refusal entries, X-Cost observation, writer failure isolation.
5. Run the suite and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | paid 402 flow completes | one `settled` line: host, amount 10000, tx from receipt header | ledger over stub writer |
| 2 | refused payment | one `refused` line with the reason, no tx | ledger |
| 3 | response with `X-Cost: 0.0042` header | one `observed` line with the cost | ledger |
| 4 | writer throws | payment flow still completes; the ledger error is swallowed | ledger |
| 5 | ten paid requests | ten lines, valid JSON each | ledger |
