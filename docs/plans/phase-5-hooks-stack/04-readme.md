# Task 4 — README: payments setup and the composition contract

## 1. Where this task sits

- **Phase 5 Hooks stack without surprising each other** — the documentation
  half: users can arm a wallet, and extension authors can compose hooks.
- **This task publishes R-1's contract and R-7's config surface.**
- **Starts after**: Tasks 1–3. **Waits on it**: nothing; it closes the phase.

## 2. What the developer needs to know

**Read first**

- `README.md` — current structure; the Authentication section is the model
  for the payments section.
- `docs/x402-composition.md` — the contract from Task 1, linked not repeated.
- `docs/plans/x402-fetch-hook.md` §Config sketch — the config example.

**Settled**

- The README gains: a "Payments (x402)" section with the config example, the
  safety defaults (probe-seeded allowlist, ceilings), and the ledger
  location; plus one paragraph linking the composition contract.
- Warnings are plain: the wallet can spend real USDC; ceilings are the guard.

**Edges and seam**

- Touches `README.md` only.
- Seam: markdownlint plus a read-through against the implemented behavior.

**Run**

- `npm test` stays green; no code changes.

**Unknowns**

- None.

## 3. The workflow

1. Read the README and the composition doc, then restate this task in one
   line.
2. Add the payments section with the config example and the defaults table.
3. Add the composition paragraph linking `docs/x402-composition.md`.
4. Read the whole README once for consistency (env vars, provider list).
5. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | config example in README | matches `parsePaymentsSection`'s accepted fields exactly | read-through |
| 2 | defaults stated in README | match `DEFAULT_ALLOWED_HOSTS` and the 0.25 ceiling in code | read-through |
| 3 | ledger path stated | matches `join(cwd, ".pi", "x402-ledger.jsonl")` | read-through |
