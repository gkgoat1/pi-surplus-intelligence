# Task 5 — Cap the shared retry loop so a paid Bu0y fill never auto-replays

## 1. Where this task sits

- **Phase 2 Surp, Bu0y, and Ruvicode show up as providers**.
- **This task hardens R-8 Bu0y as a provider**: Bu0y warns that re-executing a
  failed fill can pay twice, so the extension's generous retry budget must not
  apply to Bu0y 502s.
- **Starts after**: Task 4 (the provider exists). **Waits on it**: nothing; it
  closes the phase.

## 2. What the developer needs to know

**Read first**

- `src/stream.ts` — `retryFailedAssistantResponses` with `MAX_RESPONSE_ATTEMPTS`
  15; the retry decision lives here.
- `docs/plans/x402-fetch-hook.md` §Bu0y specifics — the double-pay warning and
  the 402-vs-502 distinction.
- `src/constants.ts` — the descriptor is how the stream layer can know the
  model is Bu0y-routed.

**Settled**

- Bu0y gets at most one automatic retry of a failed fill, and only when no
  assistant output was exposed (the existing buffer rule already guarantees
  that). Surp's cache-hit and normal fills keep the standard budget.
- The existing 15-attempt budget stays for Surplus, InferHub, Cheaper
  Inference, Surp, and Ruvicode.

**Edges and seam**

- Touches `src/stream.ts` and its tests (`test/stream-routing.test.ts` or a
  new focused file).
- Seam: the retry loop, driven by a stub stream factory (the pattern the
  existing stream tests use).

**Run**

- `npm test`, then `npm run typecheck`.

**Unknowns**

- How the retry loop learns the provider: `model.provider` should suffice via
  `PROVIDER_BY_ID`; confirm the model object carries it at that point.
- Bu0y's transient retry (its llms.txt describes one server-side retry at a
  clamped ceiling) is upstream behavior; this task only caps client replays.

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Write the failing test: a Bu0y model whose stream errors before output gets
   at most 2 total attempts.
3. Implement the per-provider attempt cap. Green.
4. Add the case proving Surplus keeps its 15-attempt budget.
5. Run the suite and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | Bu0y model, stream errors before any output | at most 2 stream creations, then the error surfaces | retry loop |
| 2 | Surplus model, stream errors before output | up to 15 attempts (existing behavior) | retry loop |
| 3 | Bu0y model, error after text was forwarded | no retry (existing buffer rule) | retry loop |
| 4 | explicit Pi abort on a Bu0y model | immediate abort, no retry (existing rule) | retry loop |
