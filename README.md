# Pi Surplus Intelligence Extension

Adds support for [Surplus Intelligence](https://surplusintelligence.ai),
[InferHub](https://inferhub.dev), [Cheaper Inference](https://www.cheaperinference.com),
[Surp](https://surp.ivc.lol), [Bu0y](https://bu0y.com), and
[Ruvicode](https://ruvicode.com) to Pi.

All three providers support OpenAI-compatible APIs. The extension uses the
`/v1/chat/completions` endpoint by default, and switches GPT-5-and-later model
IDs to `/v1/responses`. For stability with those models it issues the Responses
request directly through `fetch` (non-streaming) so it can normalize headers
and recover tool calls from the completed response body.
It injects `include_reasoning: "summary"` for chat-completions models to request
concise reasoning previews from closed models, maps Pi's thinking level to
OpenAI's `reasoning_effort`, and falls back to displaying reasoning-token counts
when a model reasons without exposing any reasoning text.

Claude models are also registered as separate `*-anthropic` providers using Pi's
native Anthropic Messages adapter. This sends Claude thinking blocks and tool
calls/results using Anthropic's native message format.

## Usage

Set one or more provider API keys:

```bash
export SURPLUS_INTELLIGENCE_API_KEY="your-key"
export INFERHUB_API_KEY="your-key"
export CHEAPER_INFERENCE_API_KEY="your-key"
export SURP_API_KEY="your-key"        # optional; surp/free needs no key
export BU0Y_API_KEY="your-bu0y-key"    # prepaid credits; api.bu0y.com
export RUVICODE_API_KEY="your-key"     # api.ruvicode.com
```

Surp, Bu0y, and Ruvicode expose public `/v1/models` catalogs, so their model
lists load even without a key (probed in `docs/probe-results.md`). Surp's
`surp/free` route streams with neither a key nor a wallet; its paid routes
answer `402 Payment Required` with an x402 challenge — see
`docs/plans/x402-fetch-hook.md` for the wallet-payment work.

Run Pi from this repo:

```bash
pi
```

Then select a model:

```
/model surplus-intelligence/kimi-k2.7-code
/model inferhub/ag/gemini-3.7-flash-high
/model cheaper-inference/claude-opus-4.6
/model surplus-intelligence-anthropic/claude-sonnet-5
/model inferhub-anthropic/ag/claude-sonnet-4-6
/model cheaper-inference-anthropic/claude-opus-4.6
```

InferHub model IDs are vendor-prefixed (`ag/...`, `ali/...`); the `/model`
picker lists the discovered catalog, and bare IDs are rejected upstream.

Providers can also be keyed per project without environment variables — see
[Authentication](#authentication).

A provider with no key anywhere is still registered (with a small fallback
model list) so a key added later via Pi's auth flow works without touching the
extension. Set `"providers": { "<id>": { "enabled": false } }` in the config
file to hide a provider entirely.

Use `--thinking <level>` to request reasoning (`off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`). Only models that advertise reasoning support will expose
a reasoning preview. For InferHub models, requested thinking levels are clamped
to the nearest level advertised in `reasoning_levels`, since unsupported levels
are rejected by the gateway.

## Model discovery

The extension fetches each configured provider's live model list at startup
(`https://api.surplusintelligence.ai/v1/models`,
`https://api.inferhub.dev/v1/models`, and
`https://api.cheaperinference.com/v1/models`). For Surplus, the `reasoning` flag is set
only for models whose `supported_parameters` include `reasoning` or
`include_reasoning`; for InferHub, only for models advertising
`reasoning_levels`; for Cheaper Inference, from the catalog's `capabilities`.
Claude models from each catalog also appear under the matching `*-anthropic`
provider. If a catalog fetch fails, a small fallback list is used so startup
still works.

## Authentication

Each provider's key resolves in this order:

1. The project config file, `.pi/surplus-intelligence.json`:
   ```json
   {
     "providers": {
       "surplus-intelligence": { "apiKey": "$SURPLUS_INTELLIGENCE_API_KEY" },
       "inferhub": { "apiKey": "!cat ~/keys/inferhub" },
       "cheaper-inference": { "apiKey": "$CHEAPER_INFERENCE_API_KEY" }
     }
   }
   ```
   The `apiKey` value follows Pi's config-value syntax: a literal string, a
   `$VAR` / `${VAR}` environment template, or a `!command` whose stdout is the
   key (useful for password managers). Unknown provider ids are reported as
   startup warnings.
2. The provider's environment variable: `SURPLUS_INTELLIGENCE_API_KEY`,
   `INFERHUB_API_KEY`, or `CHEAPER_INFERENCE_API_KEY`.

A failing or empty `!command` leaves that provider unconfigured rather than
breaking startup; the other providers are unaffected.

## Savings-based routing

Direct Surplus requests use the `min50` route by default, which only permits
routes offering at least 50% savings. Savings routing is Surplus-only; InferHub
and Cheaper Inference requests always go to their direct upstream. Configure a
project-local override in the
same `.pi/surplus-intelligence.json` file; a per-model value takes precedence:

```json
{
  "routing": {
    "minimumSavings": 50,
    "models": {
      "known-cheap-model": 80
    }
  }
}
```

This sends ordinary models to `/v1/min50/...` and `known-cheap-model` to
`/v1/min80/...`. Values must be whole percentages from 0 through 100. Preferred
upstream-provider routes are unaffected.

## Preferred upstream providers

The extension's provider remains the model selected in Pi, but it can
transparently send each request to an authenticated Pi provider first. The preferred provider uses its
normal Pi stream/API implementation. Add an optional project-local
configuration file:

```json
// .pi/surplus-intelligence.json
{
  "preferredProviders": [
    {
      "provider": "openrouter",
      "models": {
        "kimi-k2.7-code": "moonshotai/kimi-k2.7-code"
      }
    },
    {
      "provider": "moonshotai"
    }
  ]
}
```

Entries are attempted in order. A mapping is optional; without one, the
Surplus model ID is used as the preferred provider's model ID. A route is
skipped when its model is unavailable or has no configured credentials.

A terminal preferred-provider error puts that route into an exponential-backoff
cooldown (5 seconds initially, doubling up to 5 minutes, with full jitter).
The next request uses the next healthy preferred route or Surplus itself.
Successful preferred responses clear the route's cooldown; cancellations do
not count as failures. With no config file or an empty array, behavior is
unchanged.

For direct gateway requests that fail **before any assistant output is
exposed**, the extension retries up to 15 times. Retries use capped exponential
backoff (500 ms, 1 s, 2 s, …, capped at 60 s). This is deliberately generous
for long-running Pi agents and workflows, while avoiding duplicated text or
tool calls: once output has started, a failure is reported rather than retried.
An explicit Pi cancellation stops immediately and is never retried.

The active `/model` selection is never changed by this feature. This prevents
conflicts with other extensions calling `pi.setModel` or executing separate
agents. In interactive Pi, the footer identifies the preferred upstream or its
cooldown state. The status is not emitted in print, JSON, or RPC modes.

## Payments (x402)

Surp and Surplus Intelligence answer paid requests with `402 Payment
Required` carrying an x402 challenge (USDC on Base, EIP-3009). With a wallet
configured, the extension signs and retries automatically; without one,
nothing changes and `surp/free` still works keyless.

```json
{
  "payments": {
    "wallet": { "privateKey": "$X402_WALLET_KEY" },
    "maxPerRequestUsdc": 0.25,
    "maxPerDayUsdc": 5,
    "allowedHosts": ["surp.ivc.lol", "api.surplusintelligence.ai"]
  }
}
```

The wallet key follows Pi's config-value syntax (literal, `$VAR`, or
`!command`); `X402_WALLET_KEY` in the environment is the fallback. Only the
derived address is ever displayed. The wallet needs USDC on Base, not ETH —
the facilitator pays gas.

Safety defaults: payments fire only for hosts that probed as real x402
speakers (`docs/probe-results.md`), a bare 402 (like Bu0y's
insufficient-balance signal) is never paid, and each request costs at most
`maxPerRequestUsdc` with a hard `maxPerDayUsdc` day cap. Every settled
payment and refusal is appended to `.pi/x402-ledger.jsonl` with amount,
reason, and settlement transaction. The TUI footer shows the armed wallet
and today's spend.

The paying fetch is a composable hook: a `Proxy` with a global marker key
(`Symbol.for("pi-surplus-intelligence:x402-fetch")`) that other extensions
can detect, wrap, and reconfigure without stacking payment loops. See
[docs/x402-composition.md](docs/x402-composition.md).

## Pi version compatibility

This extension supports Pi >= 0.84.0. It is verified through Pi 1.0.0,
including Pi >= 0.86's normalized `TranscriptContext` for custom providers
(system prompt and tool declarations folded into `role: "system"` transcript
entries instead of `Context.systemPrompt` / `Context.tools`). The GPT-5+ Responses
fallback (`src/responses-tools.ts`) detects which shape the resolved
`@earendil-works/pi-ai` provides and reads the current prompt/tools accordingly,
so both old and new Pi versions get correct system prompts and tool declarations
on that path.

## pi-blackhole compatibility

`pi-blackhole` runs its background consolidation agents in an isolated module
graph, so its default provider resolver cannot see custom provider APIs. This
extension registers each provider's streaming function in pi-blackhole's
process-wide bridge during startup. Surplus Intelligence or InferHub can
therefore be used as the primary model while `pi-blackhole` observer,
reflector, and dropper agents are enabled, regardless of package load order.



This extension is project-local. From the repo root run:

```bash
pi install . -l
```

Or copy/symlink the extension files into `.pi/extensions/surplus-intelligence/`
of any project you want to use it in.