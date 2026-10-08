# Task 5 — Prove pass-through for bare and malformed 402s

## 1. Where this task sits

- **Phase 1 Probe every host, then pay one request**.
- **This task hardens R-3 Never touch a non-x402 402**: the pass-through cases
  get their own focused tests, including a Bu0y-shaped fixture.
- **Starts after**: Task 4 Build the 402 → policy → sign → retry loop.
- **Waits on it**: nothing in this phase; it de-risks Task 6.

## 2. What the developer needs to know

**Read first**

- `src/x402/pay.ts` — the decision point these tests pin.
- `docs/plans/x402-fetch-hook.md` §R-3 — the pass-through contract.
- `docs/plans/x402-fetch-hook.md` §Bu0y specifics — why a bare 402 is a funding
  error, not a payment prompt.

**Settled**

- Malformed challenges (bad base64, missing `accepts`, wrong types) pass
  through exactly like bare 402s: untouched, unsigned.
- This task adds tests only unless a test exposes a bug; a bug fix is its own
  commit, `fix(x402): …`.

**Edges and seam**

- Touches `test/x402-pay.test.ts` (or a new `test/x402-passthrough.test.ts`).
  Implementation changes only on a red test that should be green.
- Seam: the same `payingFetch` stub-fetch seam.

**Run**

- `npx tsx --test test/x402-pay.test.ts` (or the new file), then
  `npm run typecheck`.

**Unknowns**

- None expected. If any case here fails against Task 4's implementation, that
  is the bug to fix, in its own commit.

## 3. The workflow

1. Read the pay module and the plan sections, then restate this task in one
   line.
2. Write the failing test for case 1 (Bu0y-shaped bare 402).
3. Make it pass — usually it already does; if not, fix in a separate commit.
4. Add cases 2–4, red first, then green.
5. Run the test suite and typecheck.
6. Commit (tests only, unless a fix was needed).

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 402 with Bu0y-style JSON body `{"error":"insufficient balance","reserveMicros":32}` and no x402 data | returned untouched; signer call count 0 | `payingFetch` |
| 2 | 402 with `X-Payment-Requirements` header holding invalid base64 | returned untouched; signer call count 0 | `payingFetch` |
| 3 | 402 with header decoding to `{"accepts": "not-an-array"}` | returned untouched; signer call count 0 | `payingFetch` |
| 4 | 402 with valid requirements but the response already carries an `X-Payment` header on the retry... (loop guard) | never more than one retry total | `payingFetch` |
