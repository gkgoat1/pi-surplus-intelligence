# Plan: x402 wallet payments on every fetch

Version 0.2 · 2026-10-07 · status: draft

**Verdict**: add one composable fetch hook that answers x402 `402 Payment Required`
challenges by signing EIP-3009 USDC authorizations with an ethers.js wallet, and
register Surp (`https://surp.ivc.lol/v1`), Bu0y, and Ruvicode as providers.
Surp is the x402-native target. Bu0y and Ruvicode are key-based today, and neither
advertises x402; Bu0y even returns 402 for "insufficient prepaid balance", so the
hook must pay only 402s that carry a valid x402 challenge and pass the rest through.
Existing providers (Surplus Intelligence, InferHub, Cheaper Inference) keep their
API keys untouched. **Next action**: Phase 1 — probe every host, then settle one
live Surp request.

## 1. Requirements

- **R-1 Wrap every fetch in a composable payment hook** — user request. `Proxy` plus
  marker key, composable with other hooks.
- **R-2 Pay valid x402 challenges with an ethers.js wallet** — user request.
  Flow per https://surp.ivc.lol/x402 and https://docs.x402.org.
- **R-3 Never touch a non-x402 402** — Bu0y llms.txt: its 402 means "reserve exceeds
  balance", with no payment challenge. Only well-formed x402 requirements get paid.
- **R-4 Surp as a provider with its routes** — user request. `surp/free`,
  `surp/value`, `surp/jev`, `surp/frontier`, `surp/fast`, `surp/vision`,
  `surp/custom` per https://surp.ivc.lol/.
- **R-5 Keep Surplus Intelligence key-first and unchanged** — existing behavior.
  API keys remain the auth for `api.surplusintelligence.ai`.
- **R-6 Give external routes opportunistic x402** — user request, OpenRouter named.
  Any host that answers with a real x402 challenge can be paid, per policy.
- **R-7 Enforce a spending policy and keep a payment ledger** — derived safety
  requirement; an autonomous wallet must have caps and an audit trail.
- **R-8 Bu0y as a provider** — user request, https://bu0y.com/. Prepaid credits,
  OpenAI-compatible at `https://api.bu0y.com/v1`, per its llms.txt.
- **R-9 Ruvicode as a provider** — user request, https://ruvicode.com/. Key-based,
  per-request pricing with an `X-Cost` response header.
- **R-10 Verify x402 support by probing, without accounts** — user note: no Bu0y or
  Ruvicode account yet. A probe classifies each host before any money moves.

## 2. The approach, requirement by requirement

### R-1 Wrap every fetch in a composable payment hook

- **Approach**: a `createPayingFetch(baseFetch, config)` factory returns a `Proxy`
  around the base fetch. The `apply` trap runs the payment flow; the `get` trap
  answers a `Symbol.for("pi-surplus-intelligence:x402-fetch")` marker key with a
  descriptor holding the hook version and the inner fetch, and hides the marker from
  enumeration. Wrapping an already-marked fetch reconfigures in place via the
  descriptor's inner reference instead of stacking a second payment loop. Other
  hooks (logging, retry, cache) wrap the paying fetch like any fetch, or sit inside
  it; payment stays innermost so outer hooks see only the final settled response.
- **Touches**: a new `src/x402/` module group, and the fetch call sites in the
  stream layer, the Responses-API path, and model discovery.
- **Test seam**: the hook itself, driven by a stub base fetch. One new seam, the
  lowest that works.
- **Acceptance**: [ ] the marker is readable via the symbol and invisible to
  `Object.keys` [ ] wrapping a marked fetch yields one payment loop, not two
  [ ] a second logging hook works on either side of the paying fetch [ ] the inner
  fetch is reachable from the marker for deliberate re-ordering
- **Hard part**: fetch identity quirks — `this` binding, `Request` brand checks —
  and picking the marker's payload so future hooks can cooperate without imports.

### R-2 Pay valid x402 challenges with an ethers.js wallet

- **Approach**: on a 402, parse x402 payment requirements (v1 `accepts` from the
  base64 header or JSON body, v2 header detected by name), pick a supported entry
  (scheme `exact`, Base `eip155:8453`, USDC `0x833589fC…A02913`), policy-check the
  price, then sign `TransferWithAuthorization` typed data (domain name `USD Coin`,
  version `2`, chain 8453) with `signTypedData`, random bytes32 nonce, `validAfter`
  0, `validBefore` now plus the offered timeout. Retry once with the base64 payload
  in `X-Payment`; read the settlement receipt from the response. The wallet is any
  ethers v6 `Signer`: a `Wallet` from `$VAR` or `!command` config, or an EIP-1193
  provider through `BrowserProvider`. The client only signs; the facilitator spends
  the gas, so no ETH is needed.
- **Touches**: `src/x402/` and the payments section of the project config.
- **Test seam**: the same hook seam as R-1 Wrap every fetch in a composable payment
  hook, with a recorded Surp 402 as the fixture.
- **Acceptance**: [ ] a stub accepts the payload shape for v1 requirements
  [ ] `validBefore` respects the offered timeout [ ] a live `surp/value` request
  settles and streams from a test wallet [ ] aborting mid-flow never signs twice
- **Hard part**: two x402 versions in the wild; the parser must fail closed.

### R-3 Never touch a non-x402 402

- **Approach**: the hook pays only when the 402 carries parseable x402 requirements
  naming a supported scheme, network, and asset. A bare 402 — Bu0y's
  insufficient-balance signal — returns to the caller untouched and surfaces as a
  funding error. Malformed or unsupported challenges also pass through unpaid.
- **Touches**: `src/x402/` requirements parser and hook decision point.
- **Test seam**: the hook seam, with a bare-402 stub and a malformed-challenge stub.
- **Acceptance**: [ ] a bare 402 passes through with no signature attempted
  [ ] a malformed challenge passes through [ ] Bu0y's 402 reads as "fund the
  account", not as a payment prompt
- **Hard part**: keeping the parser strict as facilitators add fields.

### R-4 Surp as a provider with its routes

- **Approach**: a `surp` provider descriptor, base URL `https://surp.ivc.lol/v1`,
  catalog from its free `/v1/models`, route IDs as fallback models. Auth resolves
  per request: Surp Bearer key when configured, wallet payment when a wallet is
  configured, and `surp/free` works with neither. Free-route calls skip the payment
  flow entirely.
- **Touches**: provider constants, model discovery, and the config resolver.
- **Test seam**: the existing descriptor-driven provider tests.
- **Acceptance**: [ ] the picker lists the Surp routes [ ] `surp/free` answers end
  to end with no key and no wallet [ ] a Bearer key takes precedence over the
  wallet when both exist [ ] the wallet path pays once per request
- **Hard part**: presenting "wallet instead of key" to Pi's auth model without a
  fake API key leaking into logs.

### R-5 Keep Surplus Intelligence key-first and unchanged

- **Approach**: no behavior change. The existing provider keeps its key flow; the
  hook passes its requests through unless an x402 challenge appears, which the
  probe (R-10 Verify x402 support by probing, without accounts) records.
- **Touches**: nothing new beyond the hook.
- **Test seam**: the existing provider and stream tests.
- **Acceptance**: [ ] the current test suite passes unmodified
- **Hard part**: proving the pass-through adds no measurable latency.

### R-6 Give external routes opportunistic x402

- **Approach**: payment decisions key off the challenge, not the host. A preferred
  route through OpenRouter or any other upstream that answers with a valid x402
  challenge is paid under the same policy; hosts without challenges are untouched.
  The paying fetch must survive the preferred-route option rewriting.
- **Touches**: `src/x402/` and the preferred-provider wiring.
- **Test seam**: the hook seam plus a preferred-route test with a 402 stub.
- **Acceptance**: [ ] a 402 from an OpenRouter route is paid per policy
  [ ] a 402 above the price cap is refused, not paid [ ] non-402 hosts see zero
  behavior change
- **Hard part**: confirming real OpenRouter challenges match the published spec;
  the probe table records what is actually seen.

### R-7 Enforce a spending policy and keep a payment ledger

- **Approach**: a policy object gates every payment: per-request ceiling, per-day
  ceiling, host allowlist defaulting to the probe results, supported schemes and
  assets only. Refusals surface as normal errors. A per-session JSONL ledger
  records host, route, amount, and settlement hash for each payment.
- **Touches**: `src/x402/` and the payments section of the project config.
- **Test seam**: policy unit tests; the ledger through the hook seam.
- **Acceptance**: [ ] an over-ceiling challenge is refused and logged as refused
  [ ] a host outside the allowlist is never paid [ ] every settled payment has a
  ledger line with a settlement hash
- **Hard part**: day boundaries and concurrent agents sharing one wallet.

### R-8 Bu0y as a provider

- **Approach**: a `bu0y` descriptor like the existing gateways: base URL
  `https://api.bu0y.com/v1`, `bu0y_…` Bearer key from env or config, catalog from
  its free unauthenticated `/v1/models`, a small fallback list otherwise. Credits
  are prepaid microdollars; Bu0y reserves the worst case and settles actuals, so
  its 402 maps to "fund the account or lower `max_tokens`", never to the payment
  hook (R-3 Never touch a non-x402 402). Automatic retries must not re-execute a
  paid fill: Bu0y warns a second execute can pay twice, so its 502s get at most a
  manual retry.
- **Touches**: provider constants, model discovery, config resolver, and the stream
  retry budget.
- **Test seam**: the descriptor-driven provider tests plus the probe harness.
- **Acceptance**: [ ] the provider registers keyless with a fallback catalog
  [ ] the free catalog loads without a key [ ] a 402 surfaces as a funding error
  [ ] a 502 is not auto-replayed into a double fill
- **Hard part**: agent key minting signs a Solana challenge, which an ethers.js
  EVM wallet cannot do; humans use passkeys. Minting stays out of scope until an
  EVM path exists.

### R-9 Ruvicode as a provider

- **Approach**: a `ruvicode` descriptor with a Bearer key from env or config,
  registered once the user creates an account (email or OAuth, so no automation).
  The public site publishes no base URL or docs; the descriptor ships with a
  placeholder URL confirmed from the dashboard at first login. Each response's
  `X-Cost` header lands in message diagnostics and the payment ledger. Server-side
  per-key spend caps are documented, not duplicated client-side.
- **Touches**: provider constants, model discovery, and response-header handling in
  the stream layer.
- **Test seam**: the descriptor-driven provider tests plus the probe harness.
- **Acceptance**: [ ] the provider registers with the confirmed base URL
  [ ] `X-Cost` appears in diagnostics when present [ ] a missing key degrades to
  the fallback catalog without breaking startup
- **Hard part**: everything endpoint-shaped is unverified until an account exists;
  the catalog format may differ from the other gateways.

### R-10 Verify x402 support by probing, without accounts

- **Approach**: a probe script sends one unauthenticated chat completion to each
  candidate host and classifies the answer: `401 key-required`, `402 x402` (valid
  challenge attached), `402 bare` (no challenge), or `other`. Run it against Surp,
  Bu0y, Ruvicode, Surplus Intelligence, and OpenRouter. Commit the classification
  table; it seeds the policy allowlist and gets re-run whenever a host's support is
  in question. The probe never carries a wallet, so it cannot spend.
- **Touches**: a `scripts/` entry and its fixtures under `test/`.
- **Test seam**: the probe against recorded responses; live runs are manual.
- **Acceptance**: [ ] the table is committed with one row per host [ ] Surp
  classifies as `402 x402` [ ] Bu0y classifies as `402 bare` or `401` [ ] no probe
  request includes credentials
- **Hard part**: hosts may answer differently per route; the probe samples the
  chat-completions path only.

## 3. Phases

### Phase 1 — Probe every host, then pay one request

**Covers**: R-2 Pay valid x402 challenges with an ethers.js wallet, R-3 Never touch
a non-x402 402, R-10 Verify x402 support by probing, without accounts.

**Goal**: a committed table says which hosts speak x402, and one real `surp/value`
request settles from a test wallet.

**Tasks**

- Write the probe harness: one unauthenticated call, classify the response
- Probe Surp, Bu0y, Ruvicode, Surplus Intelligence, and OpenRouter; commit the table
- Sign an EIP-3009 authorization with an ethers Wallet against a recorded Surp 402
- Build the 402 → policy → sign → retry loop behind a stub fetch
- Prove pass-through for bare and malformed 402s
- Settle one live `surp/value` request from a funded test wallet

**Proof**: the classification table is committed, the stub accepts the payload
shape, and one live paid response streams back.
**Not here**: provider registration, Proxy composition, spending caps beyond a
hard-coded test ceiling.

### Phase 2 — Surp, Bu0y, and Ruvicode show up as providers

**Covers**: R-4 Surp as a provider with its routes, R-8 Bu0y as a provider, R-9
Ruvicode as a provider.

**Goal**: all three appear in the model picker; `surp/free` streams with no wallet;
Bu0y and Ruvicode register cleanly with fallback catalogs until keys exist.

**Tasks**

- Add the Surp descriptor: routes, catalog, key-or-wallet auth rule
- Add the Bu0y descriptor: catalog from its free models endpoint, 402-as-funding
  error mapping
- Add the Ruvicode descriptor with the confirmed base URL; record `X-Cost` in
  diagnostics
- Register all three with fallback catalogs when keyless
- Cap the shared retry loop so a paid Bu0y fill never auto-replays

**Proof**: the picker lists the new providers, `surp/free` answers end to end, and
the descriptor tests pass for all three.
**Not here**: paying for anything beyond Phase 1's single settled request.

### Phase 3 — One wallet pays on every fetch

**Covers**: R-1 Wrap every fetch in a composable payment hook, R-5 Keep Surplus
Intelligence key-first and unchanged, R-6 Give external routes opportunistic x402.

**Goal**: every fetch the extension makes — streams, the Responses-API path, model
discovery, preferred-provider routes — goes through the paying hook, and a full Pi
session on Surp runs wallet-paid end to end.

**Tasks**

- Build the Proxy hook with the marker key and reconfiguration via the descriptor
- Pass the paying fetch through every `options.fetch` call site in the stream layer
- Wrap `globalThis.fetch` on session start, idempotently via the marker, for code
  that cannot take an injected fetch
- Wire the preferred-route path so a 402 from an external route is paid per policy
- Seed the default host allowlist from the probe table

**Proof**: a Surp session streams paid responses; other providers' tests pass
unchanged; the marker shows one hook despite repeated installs.
**Not here**: spending limits, ledger, footer surfaces.

### Phase 4 — The wallet cannot overspend

**Covers**: R-7 Enforce a spending policy and keep a payment ledger.

**Goal**: the user sets a per-request and per-day ceiling; every settled payment
leaves a ledger line, and refusals are visible errors.

**Tasks**

- Add the `payments` config section: wallet source, ceilings, host allowlist
- Enforce policy before signing; log refusals with their reasons
- Write the JSONL ledger; fold in Bu0y reserve or settle data and Ruvicode
  `X-Cost` when present
- Surface spend and wallet state in the footer, following the preferred-provider
  status pattern

**Proof**: an over-ceiling request refuses with a logged reason; ten paid requests
leave ten ledger lines.
**Not here**: multi-wallet, fiat reporting.

### Phase 5 — Hooks stack without surprising each other

**Covers**: hardens R-1 Wrap every fetch in a composable payment hook.

**Goal**: logging, retry, or cache hooks compose on either side of the payment
hook, and double-installation is impossible.

**Tasks**

- Write the composition contract: ordering guidance and the marker payload shape
- Test stacked hooks in both orders against the stub
- Test re-install idempotence across repeated session starts
- Document the contract in the README for other extension authors

**Proof**: the composition tests pass; two installs still produce one payment per
request.
**Not here**: hooks owned by other extensions changing their own behavior.

## Design notes

These decisions are inputs to the phases, not open questions.

### When the hook pays

The hook pays only when all hold: the response is a 402, the requirements parse as
x402, the scheme or network or asset is supported, and policy approves the amount
and host. Anything else returns untouched. Bu0y's balance 402 is the canonical
case of a 402 that must not be paid.

### Provider matrix

| Provider | Base URL | Auth | x402 |
|---|---|---|---|
| Surp | `https://surp.ivc.lol/v1` | Bearer key or wallet | native (v2) |
| Surplus Intelligence | `api.surplusintelligence.ai` | API key | yes (v2, `exact` + `upto`); key is cheaper |
| Bu0y | `https://api.bu0y.com/v1` | `bu0y_…` key, prepaid | no; 402 = low balance |
| Ruvicode | `https://api.ruvicode.com/v1` | Bearer key, prepaid | no public evidence |
| OpenRouter | `https://openrouter.ai/api` | route credentials | opportunistic via hook |

### Fetch injection points

pi-ai's `ProviderRequestOptions` already accepts `fetch?: FetchFunction`, so the
stream layer can hand the paying fetch to the built-in streams. The Responses-API
path and model discovery call `fetch` directly and take the hook explicitly.
Anything else is reached by the idempotent `globalThis.fetch` wrap.

### Bu0y specifics worth remembering

Credits are integer microdollars, prepaid and non-refundable. The worst case is
reserved before a fill and actuals settle after. `max_tokens` should always be
set; the reserve floors output at 1024 tokens. A 502 means the marketplaces
failed, and re-executing can pay twice for one answer. Agent key minting signs a
Solana challenge; the human path is passkeys. Quoting is free at `POST /v1/quote`
and needs no account — useful for tests before a key exists.

### Ruvicode specifics worth remembering

Every response carries an `X-Cost` header with the exact charge. Spend caps are
per key and server-side. Top-ups accept USDC on Base, credited automatically, but
that funds a balance; it is not per-request x402. No public API docs or llms.txt
exist, so endpoint details wait for an account.

### Config sketch

```json
{
  "providers": {
    "surp": { "apiKey": "$SURP_API_KEY" },
    "bu0y": { "apiKey": "$BU0Y_API_KEY" },
    "ruvicode": { "apiKey": "$RUVICODE_API_KEY" }
  },
  "payments": {
    "wallet": { "privateKey": "!security find-generic-password -s x402-wallet -w" },
    "maxPerRequestUsdc": 0.25,
    "maxPerDayUsdc": 5,
    "allowedHosts": ["surp.ivc.lol"]
  }
}
```

Wallet material uses the existing `$VAR` or `!command` config syntax. Keys never
sit in the file, and the signer address is derivable, so logs can show it safely.

### Dependencies

`ethers` v6 is the only new runtime dependency, for `Wallet`, `BrowserProvider`,
`TypedDataEncoder`, and random nonces.

## Open questions

- ~~Ruvicode's base URL~~ answered 2026-10-08 by probing: `https://api.ruvicode.com/v1`,
  with a public OpenAI-shaped `/v1/models`. Catalog entries carry extra fields
  (`cache_read_price`, etc.) that need mapping when the descriptor lands.
- Whether Bu0y or Ruvicode ever adopt real x402: the probe harness is the standing
  check; rerun it when either announces support.
- Whether OpenRouter's live challenges match the published x402 shape: the probe
  saw no challenge on the standard API (401); opportunistic handling stands.
- ~~Whether Surplus Intelligence direct adopts x402~~ answered 2026-10-08: it
  speaks x402 v2 (`exact` EIP-3009 and `upto` Permit2) plus a Tempo method,
  with a per-request facilitation fee, so API keys remain the default.
- Whether Surp's retry wants the v1 `X-Payment` header or v2 `PAYMENT-SIGNATURE`:
  its instructions say `X-Payment`; the live settlement task confirms.
- Whether an EVM path to Bu0y key minting ever appears: minting stays manual until
  then.
- Where the test wallet's key lives on this machine: a `!command` against the
  keychain is the working assumption.

## Changelog

- 0.3 (2026-10-08): probe results landed (`docs/probe-results.md`). Surp and
  Surplus Intelligence both speak x402 v2 with `amount` and `payment-required`;
  Ruvicode's base URL resolved to `https://api.ruvicode.com/v1`; Bu0y, OpenRouter,
  and Ruvicode are key-gated 401s. Ruvicode's catalog has its own shape.
- 0.2 (2026-10-07): added Bu0y and Ruvicode (R-8, R-9), the non-x402 402 rule
  (R-3) after Bu0y's docs showed 402 means low balance, and the probe requirement
  (R-10); re-cut the phases so probing leads.
- 0.1 (2026-10-07): first draft — hook, x402 flow, Surp provider, policy.
