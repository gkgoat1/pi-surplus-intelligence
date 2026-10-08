# Task 2 — Pass the paying fetch through every options.fetch call site

## 1. Where this task sits

- **Phase 3 One wallet pays on every fetch**.
- **This task moves R-6 Give external routes opportunistic x402** onto the
  stream path: pi-ai's `ProviderRequestOptions.fetch` carries the hook, so
  built-in streams pay their own 402s.
- **Starts after**: Task 1. **Waits on it**: Task 3 wraps the direct-call
  sites; Task 4 covers preferred routes.

## 2. What the developer needs to know

**Read first**

- `src/stream.ts` — `createGatewayStreamSimple` builds `upstreamOptions`;
  pi-ai's types accept `fetch?: FetchFunction` (see pi-ai `dist/types.d.ts`
  `ProviderRequestOptions`).
- `src/x402/hook.ts` — the factory this task consumes.
- `src/x402/wallet.ts` (to be created) — wallet resolution from config/env;
  the signer source for the whole phase.

**Settled**

- The paying fetch is only attached when a wallet is configured; without one,
  options pass through unchanged (no behavior change for key-only users).
- `options.fetch` already set by a caller wins unless it carries our marker —
  in that case reconfigure in place, never stack.
- `surp/free` calls skip signing by server behavior (no challenge), not by
  client detection; the hook sees only 402s.

**Edges and seam**

- Touches `src/stream.ts`, new `src/x402/wallet.ts`, tests. Leaves the
  Responses-API direct path for Task 3.
- Seam: `createGatewayStreamSimple` with stubbed helpers — the pattern in
  `test/stream-routing.test.ts`.

**Run**

- `npm test`, then `npm run typecheck`.

**Unknowns**

- Whether the built-in completions stream actually forwards `options.fetch`
  (pi-ai docs say some adapters may reject it). Verify with a stub; if the
  built-in ignores it, stop and say so — that changes the phase.

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Write the failing test: with a wallet configured, the options passed to the
   built-in stream carry a fetch bearing the marker.
3. Implement wallet resolution (`$VAR`/`!command` via the existing config
   syntax) and the options injection. Green.
4. Add cases: no wallet → untouched options; caller-supplied fetch → composed.
5. Verify the built-in stream forwards the fetch (stub-level).
6. Run the suite and typecheck.
7. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | wallet configured, stream built | upstream options carry a marked fetch | `gatewayStreamSimple` |
| 2 | no wallet configured | options carry no fetch; existing tests unmodified pass | `gatewayStreamSimple` |
| 3 | caller's `options.fetch` set | the paying hook composes with it (caller fetch is `inner`) | `gatewayStreamSimple` |
| 4 | built-in completions stream invoked | the injected fetch is the one that runs (stub assertion) | stream helpers stub |
| 5 | wallet from `$VAR` template in config | signer resolves without logging key material | wallet resolution |
