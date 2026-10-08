# Task 2 — Probe the five hosts, commit the table

## 1. Where this task sits

- **Phase 1 Probe every host, then pay one request**.
- **This task finishes R-10 Verify x402 support by probing, without accounts**:
  the classification table exists in the repo and seeds later policy work.
- **Starts after**: Task 1 Probe harness. **Waits on it**: Phase 3's allowlist
  seeding reads this table.

## 2. What the developer needs to know

**Read first**

- `scripts/probe-x402.ts` — the harness Task 1 built; this task only runs it.
- `docs/plans/x402-fetch-hook.md` §Provider matrix — the five hosts and their
  expected auth shapes.

**Settled**

- Hosts under probe: Surp (`https://surp.ivc.lol/v1`), Bu0y
  (`https://api.bu0y.com/v1`), Ruvicode (base URL unknown; probe the site's
  documented chat path if discoverable, else record `unknown endpoint`),
  Surplus Intelligence (`https://api.surplusintelligence.ai/v1`), OpenRouter
  (`https://openrouter.ai/api/v1`).
- The probe sends no credentials. A request that hangs past 15 s is classified
  `other` with a timeout note.

**Edges and seam**

- Touches `docs/plans/x402-fetch-hook.md` (one table) and a new
  `docs/probe-results.md`. No code changes.
- Seam: none; this is a data-collection task verified by re-running the probe.

**Run**

- `npx tsx scripts/probe-x402.ts` and record the output.

**Unknowns**

- LuLu may block a new outbound host; a network error is not a result. If a
  host cannot be reached after approval, record `unreachable` with the date and
  move on — do not classify it.
- Ruvicode's endpoint is unpublished. Spend at most one attempt deriving it
  from the site; otherwise record `unknown endpoint`.

## 3. The workflow

1. Read the harness and the plan's provider matrix, then restate this task in
   one line.
2. Run the probe against all five hosts.
3. Write `docs/probe-results.md`: one row per host — URL probed, status seen,
   classification, date, and a one-line note.
4. Cross-check against the plan's expectations (Surp `402 x402`; Bu0y
   `402 bare` or `401`; the rest key-gated). Note any surprise explicitly.
5. Commit the results document.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | probe Surp | `402 x402` or `401` (paid route), and `surp/free` may answer 200 | live probe |
| 2 | probe Bu0y | `401 key-required` or `402 bare`, never `402 x402` | live probe |
| 3 | probe Surplus Intelligence | `401 key-required` | live probe |
| 4 | probe OpenRouter | `401 key-required` | live probe |
| 5 | probe Ruvicode | any classification; `unknown endpoint` acceptable | live probe |

Expected values come from each site's published docs, not from the code.
Surprises belong in the notes column, not in silently edited expectations.
