# Task 3 — Wrap globalThis.fetch idempotently for direct call sites

## 1. Where this task sits

- **Phase 3 One wallet pays on every fetch**.
- **This task finishes R-1's coverage claim**: code that calls `fetch` directly
  (the Responses-API path, model discovery) pays through the same hook.
- **Starts after**: Task 1. **Waits on it**: Task 4; Phase 5's idempotence
  hardening builds on the global wrap.

## 2. What the developer needs to know

**Read first**

- `src/responses-tools.ts` line ~196 — the direct `fetch` call for the
  Responses API.
- `src/models.ts` `fetchModels` — the direct catalog fetch.
- `index.ts` — session lifecycle; the wrap installs on session start and the
  release happens on shutdown.

**Settled**

- The global wrap is idempotent via the marker: installing twice (two
  sessions, two extension loads) yields one payment loop.
- Uninstall on session shutdown restores the exact prior `globalThis.fetch`.
- Only when a wallet is configured; otherwise `globalThis.fetch` is untouched.

**Edges and seam**

- Touches `index.ts`, `src/x402/hook.ts` (global install/uninstall), tests.
  The direct call sites themselves need no edits — that is the point of the
  global wrap.
- Seam: hook tests with a fake `globalThis` object; install/uninstall is a
  pure function over a mutable host reference.

**Run**

- `npm test`, then `npm run typecheck`.

**Unknowns**

- Whether wrapping `globalThis.fetch` interferes with other Pi code that
  caches the fetch reference before the session starts. The wrap mutates in
  place only at session boundaries; mid-session swaps are out of scope.
- Node's `fetch` and `Request` identity: the wrapped fetch must accept
  everything the original accepted (covered by delegating `apply`).

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Write the failing test: installing on a fake global wraps its fetch with a
   marked paying fetch.
3. Implement install/uninstall. Green.
4. Add cases: double install, uninstall restores identity, no-wallet no-op.
5. Wire install into `session_start` and uninstall into `session_shutdown` in
   `index.ts`, gated on wallet configuration.
6. Run the suite and typecheck.
7. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | install on a fake global | `global.fetch` carries the marker; a 402 through it gets signed | install |
| 2 | install twice | one marker, one payment loop, original still reachable as `inner` | install |
| 3 | uninstall after install | `global.fetch` is `===` the pre-install function | uninstall |
| 4 | install with no wallet configured | `global.fetch` untouched | install |
| 5 | Responses-API-style direct call after install | a 402 challenge is paid without the call site changing | integration through fake global |
