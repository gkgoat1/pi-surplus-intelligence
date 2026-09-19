# Multi-Provider Plan: Surplus Intelligence + InferHub

Goal: make `pi-surplus-intelligence-extension` register **two** providers —
Surplus Intelligence (`https://api.surplusintelligence.ai/.../v1`, existing) and
InferHub (`https://api.inferhub.dev/v1`, new) — with per-provider API keys that
can come from a project config file **or** environment variables (never hard-coding
keys in the extension source). Providers without credentials anywhere are
skipped at startup, so the extension works for users who only use one of them.

This is a plan document only; no code changes yet.

---

## 1. Design decisions (lock these before writing code)

1. **One generic "Surplus-family" provider abstraction.** Surplus Intelligence
   and InferHub are both OpenAI-compatible gateways that speak the same dialect
   the extension already implements (chat completions with
   `include_reasoning: "summary"` / `reasoning_effort`, Responses API for
   GPT-5+, savings-routing paths, upstream-error sentinels, model-swap
   fingerprinting). Rather than special-casing two providers, refactor
   `src/constants.ts` into a **provider descriptor** type and register N of them.
2. **Provider IDs.** `surplus-intelligence` stays unchanged (backward compat
   for existing model selections, preferred-provider config keys, and status
   UI). InferHub gets `inferhub`. API strings become `surplus-openai-completions`
   (unchanged) and `inferhub-openai-completions`.
3. **Config-file keys live in the existing project config.**
   `.pi/surplus-intelligence.json` gains a top-level `"providers"` section so
   all credentials/config for this extension live in one place. Keys resolve in
   this precedence order:
   1. config file (`providers.inferhub.apiKey` / `providers.surplus-intelligence.apiKey`)
   2. the provider's env var (`INFERHUB_API_KEY` / `SURPLUS_INTELLIGENCE_API_KEY`)

   The config value supports Pi's config-value syntax (see §3.2): literal
   string, `$VAR`/`${VAR}` env templates, and `!command` — with a hard
   dependency check that the running Pi's `resolve-config-value` supports it
   (Pi ≥ 0.84 does; the peerDependency floor already guarantees this).
4. **The stream wrapper is shared but provider-aware.** `src/stream.ts`'s
   custom stream (retries, claimed-error sentinel handling, thinking
   compression, fingerprinting) should apply to both providers, but
   provider-specific behavior must key off the model's provider — not off
   globals — so concurrent agents on different providers don't cross-contaminate.
5. **Savings routing (`/min{N}/v1`) remains Surplus-only.** The
   `routeBaseUrl` rewrite and preferred-provider fallback currently assume
   Surplus. InferHub streams go direct. Preferred-provider fallback *can* apply
   to InferHub models (a fallback route is just another Pi provider), gated by
   config.
6. **InferHub base URL is exactly `https://api.inferhub.dev/v1`** (the
   OpenAI-compatible root). Surplus keeps `https://api.surplusintelligence.ai`
   plus the existing `/min{N}/v1` rewrite for routing — the extension currently
   passes the bare host as `baseUrl` and relies on built-in streams appending
   paths; verify InferHub's expected path convention during implementation
   (the built-in `openai-completions.js` client passes `model.baseUrl` straight
   to the OpenAI SDK, so `baseUrl` must be the full `/v1` root for InferHub —
   Surplus's `routeBaseUrl` already appends `/v1` itself, which is why bare-host
   works there; make both descriptors carry an explicit `baseUrl` and a
   `modelsUrl`, and make the stream's URL construction uniform).

   **TODO(verify):** confirm what path the built-in stream actually hits for
   Surplus today (host-only base URL + SDK default paths) so InferHub gets the
   equivalent treatment and neither double-appends `/v1`.

---

## 2. File-by-file changes

### 2.1 `src/constants.ts` → provider descriptors

Replace the flat constants with a descriptor array:

```ts
export type ProviderDescriptor = {
  id: string;            // pi provider id ("surplus-intelligence", "inferhub")
  name: string;          // display name
  baseUrl: string;       // OpenAI-compatible root, includes /v1
  modelsUrl: string;     // `${baseUrl}/models`
  apiKeyEnvVar: string;  // "SURPLUS_INTELLIGENCE_API_KEY", "INFERHUB_API_KEY"
  api: Api;              // "surplus-openai-completions", "inferhub-openai-completions"
  supportsSavingsRouting: boolean; // true only for Surplus
};

export const PROVIDERS: ProviderDescriptor[] = [ /* surplus, inferhub */ ];
export const PROVIDER_BY_ID: Record<string, ProviderDescriptor>;
```

Keep re-exporting `PROVIDER_ID`, `API`, etc. as Surplus aliases **only if** some
external consumer imports them (check: they're internal to this repo, so drop
the aliases and fix imports instead — cleaner).

### 2.2 `src/models.ts` — parameterize discovery and mapping

- `fetchModels(descriptor, apiKey)` instead of `fetchModels(apiKey)`; use
  `descriptor.modelsUrl` and per-provider error messages.
- `mapSurplusModel(model, descriptor)` → set `api: descriptor.api`. Rename to
  `mapGatewayModel`.
- `fallbackModels(descriptor)` → return the descriptor's fallback list. Add an
  InferHub fallback list (**TODO(verify):** InferHub's stable model IDs; until
  confirmed, use a minimal one-model fallback mirroring InferHub's flagship,
  or an empty list with a startup warning — an empty list is acceptable because
  Pi tolerates providers with zero models, but prefer one real model so the
  provider is usable when the catalog is unreachable).
- `usesOpenAIResponsesApi(modelId)` is provider-agnostic; leave as is.

### 2.3 New: `src/provider-config.ts` — credential + config resolution

Extract the config-file parsing pieces of `preferred-providers.ts` that are
about *loading the JSON file* into a shared module:

```ts
export type ProviderFileConfig = {
  apiKey?: string;        // literal | $VAR template | !command
  enabled?: boolean;      // default true; explicit false hard-disables
  // future: headers, baseUrl override
};

export type ResolvedCredentials =
  | { ok: true; apiKey: string; source: "config" | "environment" }
  | { ok: false; missingEnvVar: string };

export function resolveProviderCredentials(
  descriptor: ProviderDescriptor,
  fileConfig: ProviderFileConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedCredentials
```

Resolution rules:
1. `fileConfig.enabled === false` → `{ ok: false }` (provider not registered).
2. `fileConfig.apiKey` present:
   - starts with `!` → run the command (reuse Pi's semantics; execute with the
     user's shell config per `resolve-config-value.js`, capture stdout, trim).
     Fail → treat as unconfigured with a startup warning (do not throw; a
     broken key command must not take down the other provider).
   - contains `$VAR`/`${VAR}` → expand against `env`; missing var → unconfigured
     + warning naming the missing var.
   - otherwise → literal key.
3. No config key → `env[descriptor.apiKeyEnvVar]`.
4. Nothing found → `{ ok: false }`.

This module also exports `loadExtensionConfig(cwd)` used by both startup
credential resolution and the session-scoped preferred-providers loading, so
the file is parsed once with one schema (§3.1).

**Note on `pi.registerProvider({ apiKey })`:** the extension currently passes
`apiKey: "$SURPLUS_INTELLIGENCE_API_KEY"` and lets Pi resolve env vars at
request time. For config-sourced keys, pass the **resolved literal** string
instead. Keep passing the `$VAR` template when the key came from the env var
itself, so Pi's auth-status UI keeps reporting "environment" as the source and
key rotation without restart keeps working. (Pi's composer treats an
extension-provided literal as a `fallback` source — acceptable for config-file
keys.)

### 2.4 `index.ts` — register each configured provider

Restructure the default export:

```ts
export default async function (pi: ExtensionAPI) {
  const helpers = await loadStreamHelpers().catch(() => undefined);
  if (!helpers) throw new Error("Failed to load built-in openai streams.");

  const fileConfig = loadExtensionConfig(process.cwd()); // startup-best-effort; session_start re-reads per project
  const streamSimple = createGatewayStreamSimple(helpers); // single wrapper, provider-aware via model.provider

  for (const descriptor of PROVIDERS) {
    const creds = resolveProviderCredentials(descriptor, fileConfig.providers?.[descriptor.id]);
    // Register even without credentials? NO — Pi needs auth to use the provider,
    // but registering lets the catalog load later. Decision: register always,
    // discover models only when we have a key; fetchModels gets the resolved key.
    let models = fallbackModels(descriptor);
    if (creds.ok) {
      try { models = await fetchModels(descriptor, creds.apiKey); } catch { /* keep fallback */ }
    }
    registerBlackholeStreamBridge(descriptor.api, streamSimple);
    pi.registerProvider(descriptor.id, {
      name: descriptor.name,
      baseUrl: descriptor.baseUrl,
      apiKey: creds.ok && creds.source === "config" ? creds.apiKey : `$${descriptor.apiKeyEnvVar}`,
      api: descriptor.api,
      authHeader: true,
      models,
      streamSimple,
    });
  }
  // ...existing session hooks unchanged except STATUS_KEY generalization (§2.6)
}
```

Open question to resolve during implementation: **register-always vs
register-when-configured.** Registering always keeps `pi-blackhole`'s bridge
complete and lets a user add a key mid-session via Pi's auth flow (Pi stores
runtime keys against the registered provider id). Recommend register-always.

`enabled: false` in config is the escape hatch to fully hide a provider.

Startup config-load caveat: the extension entry runs before `session_start`,
so `process.cwd()` is the best available project root at registration time;
the session hook already re-reads config per project cwd for routing — extend
that to refresh credentials only if it proves necessary (Pi caches provider
config at registration; document that changing keys requires a restart unless
sourced from env).

### 2.5 `src/stream.ts` — provider-aware wrapper

- Rename `createSurplusStreamSimple` → `createGatewayStreamSimple`; error
  strings (`emptyAssistantResponseError`, upstream-error module) use
  `descriptor.name` via `PROVIDER_BY_ID[model.provider]`.
- Savings-routing rewrite (`minimumSavingsForModel` + `routeBaseUrl`) applies
  only when `PROVIDER_BY_ID[model.provider].supportsSavingsRouting`.
- Everything else (retry/backoff, claimed-error sentinel, thinking-compression
  buffer, fingerprint diagnostic, pi-blackhole bridge) is provider-agnostic and
  stays.
- The reasoning-evidence fallback ("Model used N reasoning tokens…") applies to
  both providers — it keys off `!route && !sawThinking && reasoningTokens`,
  which is already model-driven. No change.

### 2.6 `src/preferred-providers.ts` — multi-provider routing/status

- `minimumSavingsForModel`, `matchingRoutes`, `updatePreferredProviderStatus`
  currently bail unless `model.provider === PROVIDER_ID` (Surplus). Replace
  with `PROVIDER_BY_ID[model.provider]` membership:
  - savings routing: Surplus only (`supportsSavingsRouting`).
  - preferred-provider fallback + status UI: both providers. Route health keys
    (`routeKey`) already include provider id, so no migration.
- The status string is hardcoded `"Surplus fallback: …"` / `"Surplus upstream"`.
  Parameterize with the provider display name (status key can stay
  `"surplus-intelligence"` — it's a UI slot id, invisible to users — or rename
  to a neutral key; minor, decide in review).
- Config schema: `preferredProviders[].provider` entries continue to name Pi
  provider ids for *fallback targets*. The fallback *source* models are now
  both providers' models — no schema change needed, since matching is driven by
  the active model.

### 2.7 `src/thinking-compression.ts` / `src/fingerprint.ts`

- `thinking-compression.ts` keys eligibility off the model identity passed in;
  already provider-agnostic via `sourceIdentity`. No change expected beyond
  confirming InferHub model ids get sensible defaults in
  `compressionEligible`.
- `fingerprint.ts` warning strings mention "Surplus" — parameterize with the
  provider display name (the analyzer takes `model.id`; pass the descriptor or
  display name through). Symbol keys (`pi-surplus-intelligence:*`) stay —
  they're process-global namespaces, not user-facing.

### 2.8 Docs & metadata

- `README.md`: new "Providers" section documenting both providers, the
  `INFERHUB_API_KEY` env var, and the config-file `providers` block (§3.1
  example). Update the Authentication section to describe precedence
  (config → env) and the `$VAR` / `!command` syntax.
- `package.json`: description/keywords mention both providers
  (`"pi extension adding Surplus Intelligence and InferHub as model providers"`).
  Package *name* stays `pi-surplus-intelligence-extension` (renaming a
  published/installed package breaks `pi install . -l` links; not worth it).
- `PLAN.md`, `THINKING-COMPRESSION-PLAN.md` etc. reference Surplus by name —
  leave historical docs alone.

---

## 3. Configuration surface

### 3.1 Config file: `.pi/surplus-intelligence.json` (extended)

```json
{
  "providers": {
    "surplus-intelligence": {
      "apiKey": "$SURPLUS_INTELLIGENCE_API_KEY"
    },
    "inferhub": {
      "apiKey": "sk-ih-literal-key-here"
    }
  },
  "routing": {
    "minimumSavings": 50,
    "models": { "known-cheap-model": 80 }
  },
  "preferredProviders": [
    { "provider": "openrouter", "models": { "kimi-k2.7-code": "moonshotai/kimi-k2.7-code" } }
  ]
}
```

- `providers.<id>.apiKey`: literal, `"$VAR"`/`"${VAR}"` template, or
  `"!security find-generic-password …"` command. Optional.
- `providers.<id>.enabled: false`: skip registering that provider entirely.
- Unknown provider ids under `providers` → startup warning (typo guard), not
  an error.
- Security: the file is only read when the project is trusted
  (`ctx.isProjectTrusted()`), matching existing routing config behavior. The
  **startup** credential read happens before trust is established — use
  `process.env` only at startup and defer config-file keys to the
  `session_start` hook if trust gating is required there too (**decision
  needed**; simplest correct approach: read config-file keys at startup from
  `process.cwd()` regardless — Pi already executes extension code from the
  project at that point, so trust is implied by loading the extension itself —
  but flag this in review since `!command` keys execute shell).
  Safer default to implement: support literal and `$VAR` forms at startup;
  evaluate `!command` keys only after `session_start` confirms trust, else warn.

### 3.2 Environment variables

| Provider              | Env var                        |
| --------------------- | ------------------------------ |
| Surplus Intelligence  | `SURPLUS_INTELLIGENCE_API_KEY` (unchanged) |
| InferHub              | `INFERHUB_API_KEY`             |

Env remains the zero-config path; config-file keys exist for users who can't
or don't want to set env vars (and for per-project keys, since the config file
is project-local).

---

## 4. Test plan (`test/`)

Existing suites to update (they hardcode `"surplus-intelligence"` where
provider-generic behavior is now expected):

1. `test/models.test.ts` — add cases: `mapGatewayModel` stamps the correct
   `api` per descriptor; `fetchModels` uses the descriptor's `modelsUrl`;
   per-provider fallback lists are well-formed (required Model fields present).
2. `test/stream-routing.test.ts` — parametrize the harness to run the same
   retry/routing cases for both provider ids; add a case asserting InferHub
   models do **not** get the `/min{N}/v1` rewrite while Surplus models do.
3. `test/preferred-providers.test.ts` — add cases: InferHub source model
   matches preferred fallback routes; route-health keys don't collide across
   providers with same model id.
4. New `test/provider-config.test.ts` — credential resolution matrix:
   literal / `$VAR` / `${VAR}` / missing var / `!command` success+failure /
   env fallback / `enabled: false` / precedence (config beats env). Mock
   `env` and command execution via injected functions (design
   `resolveProviderCredentials` to take injectable `exec` for testability).

Run `npm run typecheck && npm test` before committing.

---

## 5. Implementation order (checkpoints)

1. `src/constants.ts` descriptors + fix all imports (`rg PROVIDER_ID|API_KEY_ENV_VAR|BASE_URL|MODELS_URL`).
2. `src/models.ts` parameterization + tests for step 1–2 green.
3. `src/provider-config.ts` + unit tests (no behavior change to existing
   providers yet — Surplus still env-only).
4. `index.ts` loop registration + config-file keys (both providers live).
5. `src/stream.ts` + `src/preferred-providers.ts` + `src/fingerprint.ts`
   generalization; savings routing stays Surplus-only.
6. README/package.json updates.
7. Manual smoke: `SURPLUS_INTELLIGENCE_API_KEY=… INFERHUB_API_KEY=… pi` →
   `/model inferhub/<model>` streams; `/model surplus-intelligence/…` unchanged;
   config-file-only key (env unset) works.

---

## 6. Open questions to verify during implementation

1. **InferHub catalog shape**: does `GET https://api.inferhub.dev/v1/models`
   return the OpenRouter-style envelope (`architecture.input_modalities`,
   `supported_parameters`, `pricing.prompt/completion`,
   `top_provider.context_length`) that `mapSurplusModel` parses? If it's plain
   OpenAI (`{ data: [{ id }] }`), `mapGatewayModel` needs per-provider
   normalization — the descriptor gets a `mapModel` hook.
2. **InferHub reasoning dialect**: does it accept `include_reasoning` /
   `reasoning_effort`, and GPT-5-style `/v1/responses`? If it only speaks chat
   completions, `usesOpenAIResponsesApi` routing must be per-provider
   (descriptor flag, e.g. `supportsResponsesApi: boolean`).
3. **Surplus path convention** (the `/v1` question from §1.6): trace the
   actual request URL for a Surplus chat-completion today and make both
   descriptors' `baseUrl` values produce correct URLs under the built-in
   streams.
4. **Trust gating for `!command` keys at startup** (§3.1) — decide before
   shipping; the interim rule (literal/`$VAR` at startup, `!command` only after
   trust) is the conservative default.
5. Whether to keep registering providers with no credentials (recommended:
   yes, for `pi login`-style mid-session key entry and pi-blackhole bridge
   completeness).
