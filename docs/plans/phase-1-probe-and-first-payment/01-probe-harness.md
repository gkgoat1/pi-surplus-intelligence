# Task 1 — Probe harness: one unauthenticated call, classify the response

## 1. Where this task sits

- **Phase 1 Probe every host, then pay one request**, whose goal is a committed
  table of which hosts speak x402, plus one live settled Surp payment.
- **This task moves R-10 Verify x402 support by probing, without accounts** into
  place: the classifier exists and is proven against recorded responses.
- **Starts after**: nothing. **Waits on it**: Task 2 Probe the five hosts and
  commit the table.

## 2. What the developer needs to know

**Read first**

- `docs/plans/x402-fetch-hook.md` §R-10 — the classification vocabulary the
  probe must emit.
- `test/provider-config.test.ts` — the house style for node:test suites here.
- `package.json` — the test runner is `tsx --test test/**/*.test.ts`; scripts
  run with `tsx`.

**Settled**

- Classification vocabulary is fixed: `401 key-required`, `402 x402`,
  `402 bare`, `other`. Do not add a fifth state.
- The probe never carries credentials; no wallet, no API key, no auth header.
- The probe samples the chat-completions path only.

**Edges and seam**

- New files only: `scripts/probe-x402.ts` and `test/x402-probe.test.ts`. Touches
  no existing module.
- Seam: `classifyProbeResponse(response)` as a pure function, tested against
  recorded responses. The live `fetch` is a separate, untested wrapper.

**Run**

- `npm test -- test/x402-probe.test.ts` (via `npx tsx --test`), then
  `npm run typecheck`.

**Unknowns**

- tsx's glob expansion for `test/**/*.test.ts` — check how it behaves before
  adding the new file. If an existing suite silently stops running, stop and
  say so.

## 3. The workflow

1. Read the two files above, then restate this task in one line.
2. Write the failing test for case 1, at the classifier seam.
3. Implement the smallest classifier that passes. Run the test.
4. Add cases 2–5, red first, then green.
5. Write `scripts/probe-x402.ts`: it takes a URL (or defaults to the five
   hosts), sends one unauthenticated chat completion with `max_tokens: 1`,
   prints one line per host with its classification.
6. Run the test suite and typecheck.
7. Commit the harness (fixtures in the test file, no live calls in tests).

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | status 401, empty body | `401 key-required` | `classifyProbeResponse` |
| 2 | status 402 with base64 `X-Payment-Requirements` decoding to `{"x402Version":1,"accepts":[{"scheme":"exact","network":"base","maxAmountRequired":"500","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}]}` | `402 x402` | `classifyProbeResponse` |
| 3 | status 402, JSON body with a valid `accepts` array, no header | `402 x402` | `classifyProbeResponse` |
| 4 | status 402, no payment data anywhere | `402 bare` | `classifyProbeResponse` |
| 5 | status 402, header present but base64-decodes to invalid JSON | `402 bare` | `classifyProbeResponse` |
| 6 | status 200 | `other` | `classifyProbeResponse` |

A valid `accepts` entry requires `scheme: "exact"`, a non-empty `network`, a
numeric `maxAmountRequired`, and an `asset` address string. Anything less is
not x402 for classification purposes.
