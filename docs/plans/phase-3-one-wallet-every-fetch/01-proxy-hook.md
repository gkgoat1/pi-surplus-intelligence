# Task 1 — Proxy hook with marker key and in-place reconfiguration

## 1. Where this task sits

- **Phase 3 One wallet pays on every fetch**, whose goal is that every fetch
  the extension makes goes through the payment hook.
- **This task moves R-1 Wrap every fetch in a composable payment hook** into
  place: the Proxy, the marker key, and idempotent re-wrapping exist.
- **Starts after**: Phase 1's `payingFetch`. **Waits on it**: Tasks 2–4 wire
  it into call sites.

## 2. What the developer needs to know

**Read first**

- `src/x402/pay.ts` — the plain fetch wrapper this task adds composition to.
- `docs/plans/x402-fetch-hook.md` §R-1 — the marker contract: readable via the
  symbol, invisible to enumeration, reconfigure-in-place.

**Settled**

- Marker key: `Symbol.for("pi-surplus-intelligence:x402-fetch")` — registered
  globally so separately-bundled copies of the extension recognize each other.
- The marker's value is a descriptor: `{ version, inner }` where `inner` is
  the base fetch. Wrapping an already-marked fetch swaps the descriptor's
  config instead of stacking a second payment loop.
- Non-enumerable: `Object.keys`, spread, and `JSON.stringify` never see it.

**Edges and seam**

- New files: `src/x402/hook.ts`, `test/x402-hook.test.ts`. Touches nothing
  existing.
- Seam: the hook itself, driven by stub fetches — same pattern as Phase 1.

**Run**

- `npx tsx --test test/x402-hook.test.ts`, then `npm run typecheck`.

**Unknowns**

- Whether `Function` property traps suffice or `Reflect.ownKeys` needs a
  `getOwnPropertyDescriptor` trap too — the tests decide; ownKeys exclusion
  must be proven, not assumed.

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Write the failing test for case 1 (marker readable, not enumerable).
3. Implement the Proxy. Green.
4. Add cases 2–5, red first, then green.
5. Run the suite and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | wrap a stub fetch | marker readable via symbol; `Object.keys` and spread show no marker | `createPayingFetch` |
| 2 | wrap an already-wrapped fetch with new config | one payment loop total (stub sees one sign per 402); new config applies | `createPayingFetch` |
| 3 | marker descriptor | `version` is 1; `inner` is the original base fetch | marker value |
| 4 | call the wrapped fetch | behaves identically to `payingFetch` on a 402 challenge | stub fetch |
| 5 | `marker in wrapped` | true; `Object.getOwnPropertyDescriptor` on the marker reports non-enumerable | `createPayingFetch` |
