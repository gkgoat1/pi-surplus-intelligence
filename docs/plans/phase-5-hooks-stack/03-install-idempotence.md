# Task 3 — Re-install idempotence across repeated session starts

## 1. Where this task sits

- **Phase 5 Hooks stack without surprising each other**.
- **This task proves R-1's no-double-install rule** under the real lifecycle:
  repeated `configurePayments` calls (two sessions, a reload) never stack
  payment loops on `globalThis.fetch`.
- **Starts after**: Phase 3's lifecycle wiring. **Waits on it**: Task 4's
  README note.

## 2. What the developer needs to know

**Read first**

- `src/x402/payments.ts` — `configurePayments`/`releasePayments` and the
  global install.
- `index.ts` — how many times a session can start per process.

**Settled**

- N sequential sessions on one process: the global fetch never accrues more
  than one marker, and the last release restores the original fetch.
- Concurrent sessions share the single global wrap; per-session config
  updates go through the marker's mutable state (the last config wins, which
  is acceptable while wallets are per-process).

**Edges and seam**

- Touches tests only.
- Seam: `configurePayments`/`releasePayments` against a real `globalThis`
  swap, as in `test/x402-payments.test.ts`.

**Run**

- `npm test`, then `npm run typecheck`.

**Unknowns**

- Whether two interleaved sessions with different ceilings need per-session
  config on the global hook — currently last-write-wins; the test pins this
  as documented behavior rather than a bug.

## 3. The workflow

1. Read the payments lifecycle, then restate this task in one line.
2. Write the failing test for case 1 (three sequential sessions).
3. Fix only if red; otherwise record. Then cases 2–3.
4. Run the suite and typecheck.
5. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | three sequential configure/release cycles | one marker throughout; original fetch restored after the last release | lifecycle |
| 2 | two overlapping sessions, different ceilings | one global hook; active config is the latest configure | lifecycle |
| 3 | release of session A while B active | global hook stays installed until B releases | lifecycle |
| 4 | a 402 paid during overlapping sessions | exactly one signature and one ledger entry | lifecycle |
