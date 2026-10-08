# Task 1 — Surp descriptor: routes, catalog, key-or-wallet auth

## 1. Where this task sits

- **Phase 2 Surp, Bu0y, and Ruvicode show up as providers**, whose goal is all
  three in the model picker with clean keyless registration.
- **This task moves R-4 Surp as a provider with its routes** into place: the
  descriptor, fallback routes, and catalog mapping exist.
- **Starts after**: Phase 1. **Waits on it**: nothing; other descriptors are
  independent.

## 2. What the developer needs to know

**Read first**

- `src/constants.ts` — the ProviderDescriptor shape and the PROVIDERS list.
- `src/models.ts` — `mapGatewayModel` dispatch and the fallback-model pattern.
- `docs/probe-results.md` — Surp's challenge shape and free `/v1/models`.
- `index.ts` — the registration loop this descriptor flows through.

**Settled**

- Surp routes: `surp/free`, `surp/value`, `surp/jev`, `surp/frontier`,
  `surp/fast`, `surp/vision`, `surp/custom`.
- Auth per request: Bearer key when configured, wallet when configured,
  neither for `surp/free`. The wallet wiring itself is Phase 3; this task
  registers the descriptor and its key path.
- Surp has no savings routing and no Anthropic adapter endpoint.

**Edges and seam**

- Touches `src/constants.ts`, `src/models.ts`, and their tests. Leaves the
  stream layer alone.
- Seam: the existing descriptor-driven provider tests
  (`test/provider-config.test.ts`, `test/models.test.ts`).

**Run**

- `npm test` (whole suite; the descriptor tests are the focus), then
  `npm run typecheck`.

**Unknowns**

- Whether Surp's `/v1/models` entries match the Surplus catalog shape. Fetch
  it once, live, and record the shape in the test fixture rather than guessing.
- Pi's auth UI expects an env-var name per provider; `SURP_API_KEY` is the
  choice.

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Fetch `https://surp.ivc.lol/v1/models` live; save its shape as a test
   fixture observation (not a committed dump of the whole catalog).
3. Write the failing test: the Surp descriptor registers with the seven
   fallback routes when no catalog loads.
4. Add the descriptor and catalog mapping; green the test.
5. Add cases: catalog entries map, unknown-catalog-entry tolerance, keyless
   registration.
6. Run the suite and typecheck.
7. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | Surp descriptor, catalog fetch fails | fallback models are the seven `surp/*` routes | `fallbackModels` |
| 2 | Surp catalog entry `{id, name, ...}` in Surplus shape | maps to a Pi model with the Surp api id | `mapGatewayModel` |
| 3 | catalog entry missing `id` | skipped, no throw | `mapGatewayModel` |
| 4 | no key anywhere | credentials resolve `ok: false` with guidance naming `SURP_API_KEY` | `resolveProviderCredentials` |
| 5 | config `providers.surp.apiKey` set | resolves from config | `resolveProviderCredentials` |
