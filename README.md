# Pi Surplus Intelligence Extension

Adds support for [Surplus Intelligence](https://surplusintelligence.ai) to Pi.

The provider uses Surplus Intelligence's OpenAI-compatible `/v1/chat/completions`
endpoint. The extension injects `include_reasoning: "summary"` to request
concise reasoning previews from closed models, maps Pi's thinking level to
OpenAI's `reasoning_effort`, and falls back to displaying reasoning-token counts
when a model reasons without exposing any reasoning text.

## Usage

Set your API key:

```bash
export SURPLUS_INTELLIGENCE_API_KEY="your-key"
```

Run Pi from this repo:

```bash
pi
```

Then select a model:

```
/model surplus-intelligence/kimi-k2.7-code
```

Use `--thinking <level>` to request reasoning (`off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`). Only models that advertise reasoning support will expose
a reasoning preview.

## Model discovery

The extension fetches the live model list from
`https://api.surplusintelligence.ai/v1/models` at startup. The `reasoning` flag is
set only for models whose `supported_parameters` include `reasoning` or
`include_reasoning`. If the catalog fetch fails, a small fallback list is used
so startup still works.

## Authentication

The extension reads the key from the `SURPLUS_INTELLIGENCE_API_KEY` environment
variable.

## Preferred upstream providers

Surplus remains the model selected in Pi, but it can transparently send each
request to an authenticated Pi provider first. The preferred provider uses its
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

The active `/model` selection is never changed by this feature. This prevents
conflicts with other extensions calling `pi.setModel` or executing separate
agents. In interactive Pi, the footer identifies the preferred upstream or its
cooldown state. The status is not emitted in print, JSON, or RPC modes.

## pi-blackhole compatibility

`pi-blackhole` runs its background consolidation agents in an isolated module
graph, so its default provider resolver cannot see custom provider APIs. This
extension registers its Surplus streaming function in pi-blackhole's
process-wide bridge during startup. Surplus Intelligence can therefore be used
as the primary model while `pi-blackhole` observer, reflector, and dropper
agents are enabled, regardless of package load order.

## Installation

This extension is project-local. From the repo root run:

```bash
pi install . -l
```

Or copy/symlink the extension files into `.pi/extensions/surplus-intelligence/`
of any project you want to use it in.