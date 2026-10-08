# Task 4 — Pay 402s from preferred-provider routes per policy

## 1. Where this task sits

- **Phase 3 One wallet pays on every fetch**.
- **This task finishes R-6 Give external routes opportunistic x402**: a
  preferred route (OpenRouter and friends) that answers 402 gets paid like
  any other fetch.
- **Starts after**: Task 2. **Waits on it**: Task 5 seeds the allowlist.

## 2. What the developer needs to know

**Read first**

- `src/preferred-providers.ts` — `streamPreferredRoute` and how its options
  flow; `optionsForUpstream` in `src/stream.ts` strips surplus auth and swaps
  in route auth.
- `docs/plans/x402-fetch-hook.md` §R-6 — payment decisions key off the
  challenge, not the host.
- `test/preferred-providers.test.ts` — the stub pattern for routes.

**Settled**

- A preferred route's fetch is the same paying fetch; nothing route-specific
  is added. If the route answers 402 with a valid challenge and policy allows
  the host, it is paid; otherwise untouched.
- The default allowlist (Task 5) contains only probed x402 hosts, so external
  routes are opt-in until probed.

**Edges and seam**

- Touches `src/stream.ts` (`optionsForUpstream` keeps the paying fetch across
  the auth rewrite) and tests.
- Seam: the stream-routing test seam with a preferred route stub that 402s.

**Run**

- `npm test`, then `npm run typecheck`.

**Unknowns**

- Whether `optionsForUpstream`'s auth stripping accidentally drops `fetch` —
  it destructures `apiKey`/`headers`/`env`; confirm `fetch` survives, and add
  a regression test either way.

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Write the failing test: a preferred route answering 402-with-challenge is
   paid when policy allows the host.
3. Fix whatever drops the paying fetch on the route path. Green.
4. Add cases: host outside the allowlist passes through; non-402 route
   unchanged.
5. Run the suite and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | preferred route returns 402-with-challenge, host allowlisted | paid retry reaches the route | stream-routing seam |
| 2 | same 402, host not allowlisted | 402 returned untouched, signer unused | stream-routing seam |
| 3 | route returns 200 | fetch flows once, no payment headers | stream-routing seam |
| 4 | `optionsForUpstream` with a paying fetch in options | the fetch survives the auth rewrite | unit |
