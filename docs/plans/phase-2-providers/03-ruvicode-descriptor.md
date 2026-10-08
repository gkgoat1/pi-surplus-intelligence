# Task 3 — Ruvicode descriptor: confirmed base URL, X-Cost capture point

## 1. Where this task sits

- **Phase 2 Surp, Bu0y, and Ruvicode show up as providers**.
- **This task moves R-9 Ruvicode as a provider** into place: descriptor with
  the probed base URL, catalog mapping for its entry shape, and the diagnostic
  hook for `X-Cost`.
- **Starts after**: Phase 1 (base URL confirmed). **Waits on it**: Task 4.

## 2. What the developer needs to know

**Read first**

- `docs/probe-results.md` — Ruvicode: `https://api.ruvicode.com/v1`, public
  OpenAI-shaped `/v1/models`, entries carry `cache_read_price` and friends.
- `src/models.ts` — the per-shape mapping functions; Ruvicode's extra pricing
  fields map onto `cost.cacheRead`.
- `src/stream.ts` — where response headers would be read for `X-Cost`; this
  task only marks the capture point if the header is not on the stub path.

**Settled**

- Base URL `https://api.ruvicode.com/v1`; env var `RUVICODE_API_KEY`.
- Catalog is public (probed 200 without a key), so discovery works keyless,
  like Bu0y.
- Server-side per-key spend caps stay server-side; no client duplication.

**Edges and seam**

- Touches `src/constants.ts`, `src/models.ts`, tests. `X-Cost` recording is
  scoped to a diagnostics capture in the stream layer only if trivially
  reachable; otherwise it defers to a named follow-up, recorded in the brief
  findings.
- Seam: descriptor-driven provider tests plus a catalog-shape test.

**Run**

- `npm test`, then `npm run typecheck`.

**Unknowns**

- The full Ruvicode entry shape. Fetch `https://api.ruvicode.com/v1/models`
  live and record what the fixture uses.
- Whether `X-Cost` is visible through pi-ai's built-in streams (it may be
  swallowed). If it is, record the finding; do not fork the stream for it.

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Fetch the live Ruvicode catalog; record the entry shape for the fixture.
3. Write the failing test: a Ruvicode catalog entry maps with its cache price.
4. Add the descriptor and mapping; green the test.
5. Add keyless-discovery and missing-key cases.
6. Check whether `X-Cost` is reachable from the built-in stream's response
   handling; if yes, record it into diagnostics, if no, note the deferral.
7. Run the suite and typecheck.
8. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | Ruvicode catalog entry with `cache_read_price` | maps to a Pi model with `cost.cacheRead` set | `mapGatewayModel` |
| 2 | entry missing optional pricing fields | maps with zeroed costs, no throw | `mapGatewayModel` |
| 3 | keyless catalog fetch | models returned, no `Authorization` header | `fetchModels` |
| 4 | no key anywhere | credentials `ok: false` naming `RUVICODE_API_KEY` | `resolveProviderCredentials` |
| 5 | fallback models when catalog fetch fails | a small non-empty Ruvicode list | `fallbackModels` |
