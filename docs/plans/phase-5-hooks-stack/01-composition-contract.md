# Task 1 — Write the composition contract

## 1. Where this task sits

- **Phase 5 Hooks stack without surprising each other**, whose goal is that
  logging, retry, or cache hooks compose on either side of the payment hook
  and double-installation is impossible.
- **This task documents R-1's contract** so other extension authors can rely
  on it without reading the implementation.
- **Starts after**: Phase 3 (the hook exists). **Waits on it**: Tasks 2–4
  prove what this document claims.

## 2. What the developer needs to know

**Read first**

- `src/x402/hook.ts` — the actual behavior being documented.
- `docs/plans/x402-fetch-hook.md` §R-1 — the plan's promises.
- `README.md` — where the contract section lands.

**Settled**

- The contract is short: marker key name, descriptor shape, ordering guidance
  (payment innermost; outer hooks see only settled responses), and the
  reconfigure-in-place rule.
- Claims in the contract must match tests written in Tasks 2–3; write the
  doc after or alongside them, but commit it here as the reference.

**Edges and seam**

- Touches `README.md` and `docs/x402-composition.md`. No code.
- Seam: none; verified by Tasks 2–3's tests.

**Run**

- `npm test` (unchanged suite stays green) and markdownlint cleanliness.

**Unknowns**

- None; keep it to one page.

## 3. The workflow

1. Read the hook implementation and plan section, then restate this task in
   one line.
2. Draft `docs/x402-composition.md`: the marker, the descriptor, the two
   composition orders, the idempotence rule, a minimal code example.
3. Cross-check every claim against a test name; drop or fix any unproven
   claim.
4. Link it from the README.
5. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | contract claims the marker key | a test reads `X402_FETCH_MARKER` by that symbol | test cross-reference |
| 2 | contract claims reconfigure-in-place | the re-wrap test exists and passes | test cross-reference |
| 3 | contract claims non-enumerability | the enumeration test exists and passes | test cross-reference |
