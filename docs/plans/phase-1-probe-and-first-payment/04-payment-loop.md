# Task 4 — Build the 402 → policy → sign → retry loop behind a stub fetch

## 1. Where this task sits

- **Phase 1 Probe every host, then pay one request**.
- **This task finishes R-2 Pay valid x402 challenges with an ethers.js wallet**
  and **implements R-3 Never touch a non-x402 402**: the payment flow exists as
  a fetch wrapper, and non-x402 402s pass through unsigned.
- **Starts after**: Task 3 Sign an EIP-3009 authorization.
- **Waits on it**: Task 6 Settle one live Surp request; Phase 3's Proxy hook
  wraps this function.

## 2. What the developer needs to know

**Read first**

- `src/x402/sign.ts` — the parser and signer this task composes (Task 3).
- `docs/plans/x402-fetch-hook.md` §"When the hook pays" — the four conditions,
  all must hold.
- `docs/plans/x402-fetch-hook.md` §R-7 — policy is a hard-coded ceiling for
  this phase (0.25 USDC per request); the config surface is Phase 4.

**Settled**

- Payment retried exactly once: original request, one signed retry. No loop.
- The decision key is the parsed challenge, never the hostname.
- A 402 without valid x402 requirements returns to the caller untouched.
- The signer is injected; this module never reads env or key files itself.

**Edges and seam**

- New files only: `src/x402/pay.ts`, `test/x402-pay.test.ts`.
- Seam: `payingFetch(baseFetch, { signer, maxPerRequestUsdc, now? })` driven by
  a stub `baseFetch`. The Proxy/marker composition is Phase 3; this function is
  deliberately plain so it stays wrappable.

**Run**

- `npx tsx --test test/x402-pay.test.ts`, then `npm run typecheck`.

**Unknowns**

- Whether the paid retry must preserve the original request body byte-for-byte
  (it must; clone the `Request` before consuming). If the stub shows body
  consumption issues with streaming bodies, stop and say so.
- Header casing of the payment header on retry: use `X-Payment` for v1
  challenges; if Surp's fixture shows another name, match the fixture.

## 3. The workflow

1. Read the sign module and the plan sections, then restate this task in one
   line.
2. Write the failing test for case 1 (happy path: 402 → sign → 200).
3. Implement the smallest loop that passes. Run the test.
4. Add cases 2–6, red first, then green.
5. Run the test suite and typecheck.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | stub returns 402-with-challenge then 200 | two base-fetch calls; second carries a base64 `X-Payment` header; final response is the 200 | `payingFetch` |
| 2 | stub returns bare 402 | one call; the 402 returned untouched; signer never invoked | `payingFetch` |
| 3 | challenge amount above `maxPerRequestUsdc` | the 402 returned untouched; signer never invoked | `payingFetch` |
| 4 | challenge on an unsupported network | the 402 returned untouched | `payingFetch` |
| 5 | paid retry also returns 402 | the second 402 is returned; no third attempt | `payingFetch` |
| 6 | non-402 first response (e.g. 200) | one call, response untouched | `payingFetch` |
| 7 | request with a JSON body | the retry re-sends the identical body bytes | `payingFetch` |

"Signer never invoked" cases are the R-3 guarantee; assert the signer stub's
call count, not just the absence of a payment header.
