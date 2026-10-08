# Task 1 — The `payments` config section: wallet source, ceilings, allowlist

## 1. Where this task sits

- **Phase 4 The wallet cannot overspend**, whose goal is user-set ceilings and
  a visible ledger.
- **This task moves R-7 Enforce a spending policy and keep a payment ledger**
  onto the config file: `payments` in `.pi/surplus-intelligence.json`.
- **Starts after**: Phase 3. **Waits on it**: Tasks 2–4 consume the parsed
  config.

## 2. What the developer needs to know

**Read first**

- `src/provider-config.ts` — the file loading, validation, and diagnostic
  pattern this task extends (same file, new section).
- `docs/plans/x402-fetch-hook.md` §Config sketch — the shape: `wallet`,
  `maxPerRequestUsdc`, `maxPerDayUsdc`, `allowedHosts`.
- `src/x402/payments.ts` — `PaymentsConfig`, the consumer.

**Settled**

- Config shape: `payments.wallet.privateKey` (literal/`$VAR`/`!command`),
  `payments.maxPerRequestUsdc`, `payments.maxPerDayUsdc`,
  `payments.allowedHosts` (string array, replaces the default entirely).
- Unknown fields warn; malformed sections degrade to payments-disabled with a
  diagnostic, never a crash.
- `X402_WALLET_KEY` remains the fallback when the section is absent.

**Edges and seam**

- Touches `src/provider-config.ts` (new loader), `src/x402/payments.ts`
  (accept the parsed config), `index.ts` (pass it through), tests.
- Seam: the config loader's existing test seam (`temporaryProject` pattern).

**Run**

- `npm test`, then `npm run typecheck`.

**Unknowns**

- Whether `loadProvidersFileConfig` should grow or a sibling loader should
  own `payments`: prefer extending the same file read (one parse, one
  diagnostic channel) without renaming the existing export.

## 3. The workflow

1. Read the files above, then restate this task in one line.
2. Write the failing test: a full `payments` section parses into
   `PaymentsConfig`.
3. Implement the loader. Green.
4. Add cases: missing section, malformed values, unknown-field warnings,
   allowlist replacement.
5. Wire through `configurePayments` from `index.ts`.
6. Run the suite and typecheck.
7. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | full payments section | parsed config with all four fields | loader |
| 2 | no payments section | undefined config, no diagnostics | loader |
| 3 | `maxPerRequestUsdc: "lots"` | diagnostic, payments-disabled | loader |
| 4 | unknown field `payments.foo` | warning diagnostic naming the field | loader |
| 5 | config allowlist `["openrouter.ai"]` | session allowlist is exactly that, not the default | `configurePayments` |
