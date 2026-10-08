# Task 6 — Settle one live Surp request from a funded test wallet

## 1. Where this task sits

- **Phase 1 Probe every host, then pay one request** — this task is the phase
  goal: one real paid request settles.
- **This task proves R-2 Pay valid x402 challenges with an ethers.js wallet**
  end to end against the live Surp gateway.
- **Starts after**: Tasks 3, 4, 5. **Waits on it**: nothing; it closes the
  phase.

## 2. What the developer needs to know

**Read first**

- `src/x402/pay.ts` — the loop this task drives for real.
- `docs/plans/x402-fetch-hook.md` §Config sketch — where the wallet key is
  expected to come from (`$VAR` or `!command`; open question: which keychain
  entry holds the test wallet).
- `scripts/probe-x402.ts` — the pattern for a one-off live-call script.

**Settled**

- One request, route `surp/value`, `max_tokens: 1`, ceiling 0.25 USDC.
- The wallet key comes from the environment or a `!command`; it is never
  written to disk, logged, or committed.
- This is a manual script run, not an automated test; no live network in
  `npm test`.

**Edges and seam**

- New file only: `scripts/settle-surp.ts`. Plus a short entry in
  `docs/probe-results.md` (or a new section) recording the outcome: route,
  amount, settlement hash.
- Seam: none new; the script wires `payingFetch` to `globalThis.fetch`.

**Run**

- `X402_TEST_KEY=… npx tsx scripts/settle-surp.ts` (or the agreed `!command`
  source). Manual only.

**Unknowns**

- Whether the test wallet exists and holds USDC on Base. If it does not, stop
  and ask — do not improvise funding.
- LuLu may block `surp.ivc.lol` or a facilitator host on first contact;
  approve and retry once. A persistent block is reported, not worked around.
- Surp may change its challenge shape from the recorded fixture; if the parser
  rejects a live challenge, capture the raw challenge (redact nothing — it
  contains no secrets) and stop.

## 3. The workflow

1. Read the pay module and the config sketch, then restate this task in one
   line.
2. Write `scripts/settle-surp.ts`: build a `Wallet` from the env/command
   source, wrap `fetch` with `payingFetch`, send one `surp/value` request with
   `max_tokens: 1`, print status, amount paid, and settlement hash.
3. Dry-run the script's argument parsing and wallet loading without sending
   (a `--check` flag).
4. Run it live once.
5. Record the outcome (route, amount, settlement hash, date) in the docs.
6. Commit the script and the outcome note. The phase summary follows
   separately.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `--check` with a valid key | prints the derived wallet address, sends nothing | script |
| 2 | `--check` with no key | exits non-zero with a funding-source hint | script |
| 3 | live run, funded wallet | HTTP 200, one payment ≤ ceiling, settlement hash printed | live call |
| 4 | live run, unfunded wallet | a pass-through 402 or a settle failure, reported as such | live call |
| 5 | live run | the amount recorded in docs matches the printed amount | manual |
