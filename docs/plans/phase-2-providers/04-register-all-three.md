# Task 4 — Register all three providers with fallback catalogs when keyless

## 1. Where this task sits

- **Phase 2 Surp, Bu0y, and Ruvicode show up as providers** — this task is the
  phase goal: all three appear in Pi's model picker.
- **This task finishes R-4, R-8, R-9** at the integration level: the
  descriptors from Tasks 1–3 flow through the existing registration loop.
- **Starts after**: Tasks 1, 2, 3. **Waits on it**: Task 5 Cap the retry loop.

## 2. What the developer needs to know

**Read first**

- `index.ts` — the per-descriptor registration loop: credentials, catalog
  fetch, fallback, `pi.registerProvider`.
- `src/constants.ts` — the PROVIDERS list; adding three entries is the bulk
  of this task.
- `README.md` — provider documentation pattern; the three new providers need
  their rows.

**Settled**

- Keyless registration with fallback catalogs is existing behavior; the new
  providers inherit it. Keyless *catalog discovery* (Bu0y, Ruvicode, Surp all
  expose public `/v1/models`) is the refinement: when no key exists, attempt
  the catalog fetch without auth before falling back.
- Surp's `surp/free` route must stream with no key and no wallet. That is the
  end-to-end proof; the payment hook is not wired until Phase 3.

**Edges and seam**

- Touches `index.ts` (keyless discovery attempt), `src/models.ts`
  (`fetchModels` optional auth), `README.md`, tests.
- Seam: the extension-level registration path; tests drive the descriptor
  list and the keyless fetch.

**Run**

- `npm test`, then `npm run typecheck`.

**Unknowns**

- Whether `fetchModels` can be made key-optional without disturbing the three
  existing providers — they must keep sending `Authorization` when a key
  exists. A signature change here ripples; keep the default behavior intact.
- Live `surp/free` smoke: run once manually with `pi -p` if feasible; do not
  block the commit on interactive Pi setup issues — record the attempt.

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Write the failing test: keyless providers still attempt catalog discovery
   (stubbed fetch) and fall back cleanly on failure.
3. Make `fetchModels` auth-optional; keep keyed behavior identical. Green.
4. Add the three descriptors to PROVIDERS and confirm the registration loop
   picks them up.
5. Update the README provider list and env vars.
6. Run the suite and typecheck; attempt the `surp/free` smoke if practical.
7. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | Bu0y descriptor, no key, stubbed catalog 200 | catalog models used, request carried no auth header | `fetchModels` |
| 2 | Surplus descriptor, no key, stubbed catalog 200 | unchanged: keyed providers skip discovery without a key (no authless probing of keyed hosts) | registration path |
| 3 | all six providers in PROVIDERS | ids unique, names set, env vars named | descriptor list |
| 4 | keyless provider, catalog fetch fails | fallback models registered, no throw | registration path |
