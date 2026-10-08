# x402 probe results

Probed 2026-10-08 with `npx tsx scripts/probe-x402.ts`. One unauthenticated
chat completion per host; no wallet, no API key. Re-run the probe to refresh
this table; it seeds the payment policy allowlist in Phase 3.

| Host | URL probed | Status | Classification | Note |
|---|---|---|---|---|
| Surp | `https://surp.ivc.lol/v1/chat/completions` | 402 | `402 x402` | challenge in `payment-required` header and JSON body |
| Surplus Intelligence | `https://api.surplusintelligence.ai/v1/chat/completions` | 402 | `402 x402` | challenge in `payment-required` and `x-payment-required` headers |
| Bu0y | `https://api.bu0y.com/v1/chat/completions` | 401 | `401 key-required` | no payment challenge; `GET /v1/models` needs no key |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | 401 | `401 key-required` | no x402 signal on the standard API |
| Ruvicode | `https://api.ruvicode.com/v1/chat/completions` | 401 | `401 key-required` | endpoint found by probing; OpenAI-shaped `/v1/models` is public |

## Surprises against the plan's expectations

- **Surplus Intelligence speaks x402.** The plan assumed it was key-only. Its
  402 challenge offers both `exact` (EIP-3009) and `upto` (Permit2) schemes on
  `eip155:8453`, names the payment header `PAYMENT-SIGNATURE`, and notes that
  x402 carries a per-request facilitation fee — API keys stay the cheaper path
  (see `docs/plans/x402-fetch-hook.md` R-5).
- **Surp sends x402 v2, not v1.** Its challenge uses `amount` (not
  `maxAmountRequired`), network `eip155:8453` (not `base`), and the
  `payment-required` header (not `x-payment-requirements`), though its retry
  instructions still name the v1 request header `X-Payment`. The classifier
  accepts both amount field names for this reason.
- **Surp challenges are priced per request.** The probe's `surp/value` request
  priced at 10000 atomic USDC ($0.01) with `maxTimeoutSeconds: 600`, payee
  `0x2f9518019575e048320c1e7da4dc4d6d8384c2c8`. The body includes routing
  detail (`routed_model`, `price_usd`).
- **Surplus Intelligence also advertises a Tempo/`WWW-Authenticate` payment
  method** (`method="tempo"`, chain 4217). Out of scope: the plan pays
  x402/EIP-3009 only.
- **Ruvicode's base URL is `https://api.ruvicode.com/v1`.** The site publishes
  no docs; the chat path returns 401 and `/v1/models` is public, with catalog
  entries carrying fields like `context_length`, `max_completion_tokens`, and
  `cache_read_price` — a different shape from the other gateways' catalogs.
- **Bu0y's documented 402 did not appear** in this probe: an unauthenticated
  call gets a 401 first. Its balance-exceeded 402 only reaches authenticated,
  funded accounts. The pass-through rule (R-3) still stands.

## Free, unauthenticated endpoints worth knowing

- `GET https://api.bu0y.com/v1/models` — 200, full catalog (per its llms.txt).
- `POST https://api.bu0y.com/v1/quote` — free quoting, no key (per its llms.txt).
- `GET https://api.ruvicode.com/v1/models` — 200, full catalog (probed).
- `GET https://openrouter.ai/api/v1/models` — 200, full catalog (probed).
- `GET https://surp.ivc.lol/v1/models` — listed as free in Surp's llms.txt.
