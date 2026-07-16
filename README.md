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

## Installation

This extension is project-local. From the repo root run:

```bash
pi install . -l
```

Or copy/symlink the extension files into `.pi/extensions/surplus-intelligence/`
of any project you want to use it in.