# Pi Surplus Intelligence Extension

Adds support for [Surplus Intelligence](https://surplusintelligence.ai) to Pi.

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

## Model discovery

The extension fetches the live model list from `https://api.surplusintelligence.ai/v1/models` at startup. If no `SURPLUS_INTELLIGENCE_API_KEY` is set or the fetch fails, it falls back to a small curated list.

## Authentication

The extension resolves the API key in order of priority:

1. The `SURPLUS_INTELLIGENCE_API_KEY` environment variable.
2. Pi's credential store (use `/login surplus-intelligence`).

## Installation

This extension is project-local. Place it in `.pi/extensions/surplus-intelligence/` of any project you want to use it in, or install it as a Pi package.