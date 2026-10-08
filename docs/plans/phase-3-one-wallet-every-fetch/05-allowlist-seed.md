# Task 5 — Seed the default host allowlist from the probe table

## 1. Where this task sits

- **Phase 3 One wallet pays on every fetch**.
- **This task operationalizes R-10's output**: the probe results become the
  default set of hosts the hook will pay, so opportunistic payment never
  fires on an unprobed host by default.
- **Starts after**: Phase 1 (probe table committed). **Waits on it**: Phase 4
  exposes the allowlist in config.

## 2. What the developer needs to know

**Read first**

- `docs/probe-results.md` — the classification table; `402 x402` rows are the
  seed.
- `src/x402/pay.ts` — `PayingFetchConfig`; this task adds `allowedHosts`.
- `src/x402/hook.ts` — where the default config assembles.

**Settled**

- Default allowlist: exactly the hosts that probed `402 x402` —
  `surp.ivc.lol` and `api.surplusintelligence.ai` as of 2026-10-08.
- The allowlist is a default, not a constant buried in logic: Phase 4's config
  overrides it; this task keeps the default in one exported place.
- Host matching is exact hostname, case-insensitive; no subdomain wildcards.

**Edges and seam**

- Touches `src/x402/` config assembly and tests.
- Seam: pure policy function — `hostAllowed(hostname, allowlist)` plus the
  default list export.

**Run**

- `npm test`, then `npm run typecheck`.

**Unknowns**

- None significant; this is a data-plus-guard task.

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Write the failing test: the default allowlist contains exactly the probed
   `402 x402` hosts.
3. Export the default and the matcher; wire it into `payingFetch`'s decision.
4. Add cases: case-insensitive match, subdomain rejected, empty allowlist pays
   nothing.
5. Run the suite and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | default allowlist | exactly `surp.ivc.lol`, `api.surplusintelligence.ai` | export |
| 2 | `SURP.IVC.LOL` against the default | allowed | `hostAllowed` |
| 3 | `evil-surp.ivc.lol` or `surp.ivc.lol.evil.com` | not allowed | `hostAllowed` |
| 4 | a 402 from a host not in the allowlist | passes through unsigned | `payingFetch` |
| 5 | empty allowlist | every 402 passes through unsigned | `payingFetch` |
