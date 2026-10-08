# Task 2 — Bu0y descriptor: free catalog, 402-as-funding mapping

## 1. Where this task sits

- **Phase 2 Surp, Bu0y, and Ruvicode show up as providers**.
- **This task moves R-8 Bu0y as a provider** into place: descriptor, public
  catalog, and the error mapping that keeps Bu0y's 402 out of the payment
  path.
- **Starts after**: Phase 1 (the probe fixed the facts). **Waits on it**:
  Task 4 Register all three with fallback catalogs.

## 2. What the developer needs to know

**Read first**

- `docs/probe-results.md` — Bu0y: 401 on chat, 200 on `GET /v1/models` without
  a key; 402 means reserve-exceeds-balance.
- `docs/plans/x402-fetch-hook.md` §Bu0y specifics — microdollars, reservation,
  no auto-replay on 502.
- `src/models.ts` — catalog-shape dispatch; Bu0y needs its own shape (`bu0y`).
- `src/constants.ts` — descriptor fields; Bu0y has no savings routing and no
  Anthropic endpoint.

**Settled**

- Base URL `https://api.bu0y.com/v1`; env var `BU0Y_API_KEY`.
- The catalog fetch must tolerate a missing key: Bu0y's `/v1/models` is
  unauthenticated, so discovery works keyless.
- Bu0y's 402 never reaches the payment hook as payable: the hook already
  passes bare 402s through (Phase 1); this task ensures the error surfaces as
  "fund the account or lower max_tokens", not as a payment prompt.

**Edges and seam**

- Touches `src/constants.ts`, `src/models.ts`, `index.ts` (keyless catalog
  fetch), and tests. Leaves `src/x402/` alone.
- Seam: descriptor-driven provider tests, plus a catalog-shape test with a
  recorded Bu0y entry.

**Run**

- `npm test`, then `npm run typecheck`.

**Unknowns**

- Bu0y catalog entry fields beyond what llms.txt shows (`id`, per-1M rates).
  Fetch `https://api.bu0y.com/v1/models` live and record the real shape.
- Whether `fetchModels` currently hard-requires a key — check the signature
  before assuming; keyless discovery may need an optional-key path.

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Fetch the live Bu0y catalog; record the entry shape for the fixture.
3. Write the failing test: keyless catalog fetch returns mapped models.
4. Add the descriptor, the `bu0y` catalog mapping, and the keyless-fetch path;
   green the test.
5. Add the 402-surface test: a bare Bu0y 402 through the paying fetch stays a
   funding error (already proven in Phase 1; assert the message path here).
6. Run the suite and typecheck.
7. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | Bu0y catalog entry with per-1M pricing fields | maps to a Pi model with microdollar costs | `mapGatewayModel` |
| 2 | keyless `fetchModels` for Bu0y | sends no `Authorization` header, returns models | `fetchModels` |
| 3 | no key anywhere | credentials `ok: false` naming `BU0Y_API_KEY` | `resolveProviderCredentials` |
| 4 | Bu0y 402 body through `payingFetch` | untouched response, signer call count 0 (already green; pinned here) | `payingFetch` |
| 5 | fallback models when catalog fetch fails | a small non-empty Bu0y list, ids in Bu0y slug style | `fallbackModels` |
