# Task 2 — Test stacked hooks in both orders

## 1. Where this task sits

- **Phase 5 Hooks stack without surprising each other**.
- **This task hardens R-1 Wrap every fetch in a composable payment hook**:
  a logging hook and a retry hook compose on either side of the payment hook
  without changing payment semantics.
- **Starts after**: Phase 3's hook. **Waits on it**: Task 3 idempotence.

## 2. What the developer needs to know

**Read first**

- `src/x402/hook.ts` — the marker contract under test.
- `test/x402-hook.test.ts` — the existing stub patterns.

**Settled**

- Two orders under test: logging/retry outside the payment hook (they see
  only the final settled response) and inside (they see the 402 and the
  retry).
- Neither order may cause a second signature or a lost response body.

**Edges and seam**

- Touches tests only; implementation changes only on a red test that should
  be green, in its own commit.
- Seam: the hook seam with hand-rolled logging and retry wrappers.

**Run**

- `npx tsx --test test/x402-composition.test.ts`, then `npm run typecheck`.

**Unknowns**

- Retry hooks typically re-invoke the inner fetch; an outer retry that
  re-calls the paying fetch on a settled 200 must not re-pay. The tests pin
  this.

## 3. The workflow

1. Read the hook and its tests, then restate this task in one line.
2. Write the failing test for case 1 (logging outside).
3. Fix only if red; otherwise record the pass. Then cases 2–5.
4. Run the suite and typecheck.
5. Commit (tests, plus any fix in its own commit).

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | logging hook outside the payment hook | one log line for the final 200; no 402 logged | composition |
| 2 | logging hook inside (wraps `inner`) | two log lines: the 402 and the paid 200 | composition |
| 3 | retry hook outside, first attempt fails at network level | retry re-invokes the paying fetch; exactly one signature per settled request | composition |
| 4 | response body readable by outer hook after payment | body bytes intact (clone discipline holds through the Proxy) | composition |
| 5 | third-party-style hook that spreads the fetch into an object | marker survives access via symbol; spread shows no marker | composition |
