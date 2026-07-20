# Surplus Preferred-Provider Hotswap Plan

## Goal

Allow a Surplus Intelligence model to prefer one or more direct Pi providers as
its active upstream. A preferred provider is used while it is healthy. When it
returns a terminal error, Pi switches back to the corresponding Surplus model
and temporarily suppresses that preferred route using exponential backoff.

The feature is opt-in: with no preferred-provider configuration, the extension
must retain its current Surplus-only behavior.

## Scope and behavior

- Hotswapping happens **inside `src/stream.ts` by substituting the upstream
  model**, not via `pi.setModel`. This keeps the active Pi model selection
  unchanged, so other extensions that call `pi.setModel` or run agents
  separately do not conflict with the preferred-provider route.
- State is tracked in **module-level (global) variables** so it persists across
  extension reloads, session changes, and separate agent invocations.
- A route is identified by the selected Surplus model plus a preferred provider
  and its resolved preferred model. Preferred routes are tried in configured
  order.
- Before a request, `src/stream.ts` selects the first route that:
  1. has a model registered in Pi,
  2. uses the `openai-completions` API (the only built-in stream helper
     available to this extension),
  3. has configured authentication, and
  4. is not in its cooldown period.
- The route delegates to Pi's registered stream for the preferred model, so
  providers may use any API supported by Pi (not only `openai-completions`).
- If no eligible preferred route exists, `stream.ts` uses the original Surplus
  model unchanged.
- A finalized terminal provider error (`stopReason: "error"`) from a preferred
  model marks that route unhealthy, increments its consecutive-failure count,
  and stores an exponential-backoff cooldown. The current request ends as an
  error; the next request sees the route as cooling down and falls back to the
  Surplus model automatically.
- Successful preferred responses reset that route's failure count and cooldown.
- User cancellations/aborts do **not** count as provider failures. Configuration,
  unavailable-model, and missing-auth cases are skipped without a network
  request and should not consume a failure attempt.
- Manual `/model` changes always win. Because `pi.setModel` is never used by
  this feature, an explicit non-Surplus selection simply clears the TUI status;
  an explicit Surplus selection establishes a new logical Surplus route.

## Configuration contract

Add an extension-owned, project-local configuration file:

```text
.pi/surplus-intelligence.json
```

Use an optional `preferredProviders` array. It is omitted or empty by default.
Each entry names a Pi provider and optionally maps Surplus model IDs to that
provider's model IDs:

```json
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

Resolution rules:

1. Read entries in array order.
2. For the selected Surplus model, use `models[surplusModelId]` when present;
   otherwise use the Surplus model ID unchanged.
3. Resolve that exact `provider/modelId` through Pi's model registry. An absent
   model, unavailable credentials, or incompatible entry is skipped and the
   next route is considered.
4. Reject malformed configuration (non-string provider/model IDs, duplicate
   provider/model routes, or non-object maps) with one actionable diagnostic;
   do not prevent Surplus from loading.

Keep retry policy fixed in the first release rather than adding speculative
configuration: start at 5 seconds, double after each consecutive error, cap at
5 minutes, and apply full jitter. Store `consecutiveFailures` and `retryAt` per
logical Surplus-model/preferred-model route. This makes repeated failures avoid
an immediate retry loop while allowing recovery without a restart.

## Implementation steps

1. **Add typed configuration and route helpers.**
   - Create `src/preferred-providers.ts` with the JSON schema, parsing/
     validation, model-ID resolution, route identity, exponential backoff, and
     global module-level state (config, model registry reference, and per-route
     health).
   - Read only the trusted project-local config path, gracefully treating a
     missing file as `{ preferredProviders: [] }`.
   - Keep error reporting rate-limited so an invalid file does not spam every
     turn.

2. **Wire the model registry into the global state.**
   - In `index.ts`, register a `session_start` handler that captures
     `ctx.modelRegistry` and passes it to the global state. `session_start`
     fires before any request, so the registry is available when
     `stream.ts` resolves routes. Load (or reload) the configuration from
     `ctx.cwd` at the same time.
   - Health/cooldown state is intentionally global and is not reset on session
     replacement, so repeated failures remain backed off across reloads and
     agent runs. Only the TUI status and the captured registry reference are
     refreshed per session.

3. **Perform hotswapping inside `src/stream.ts`.**
   - Update `createSurplusStreamSimple` so that, before building the upstream
     stream, it calls `resolveRoute(model)` using the captured model registry.
   - If a route is selected, delegate through Pi's model runtime with
     `streamSimple(route.resolvedModel, context, options)`. This preserves each
     preferred provider's own API/stream implementation and authentication while
     avoiding `pi.setModel`.
   - If no route is selected, use the original Surplus model unchanged.
   - Wrap the upstream stream to detect terminal errors and successes:
     - `done` event with a preferred route: call `recordSuccess(route)`.
     - `error` event with `reason === "error"` and a preferred route: call
       `recordFailure(route)`.
     - `error` events with `reason === "aborted"` or Surplus errors: do not
       modify route health.
   - Keep the existing reasoning-token fallback and `pi-blackhole` bridge
     registration unchanged.

4. **Add TUI status support from `index.ts`.**
   - Register a `before_agent_start` handler that, in TUI mode, looks up the
     current Surplus model and calls `ctx.ui.setStatus("surplus-intelligence",
     status)` with a concise label such as `Surplus fallback: OpenRouter Kimi`
     or `Surplus fallback: preferred route retrying in 38s`.
   - Register a `model_select` handler to clear the status when the user
     selects a non-Surplus model and refresh it when the user selects a Surplus
     model.
   - Register a `session_shutdown` handler to clear the status. Do not show
     interactive notifications in print/JSON modes.

5. **Preserve existing Surplus behavior and integrations.**
   - Do not alter Surplus model discovery, reasoning payload injection, or the
     reasoning-token fallback in `src/stream.ts`.
   - Hotswap uses Pi's model runtime for preferred models; the blackhole bridge
     continues to receive the same Surplus `streamSimple` and resolves its
     explicitly selected model through the existing bridge/runtime.
   - Update `README.md` with configuration, route ordering, backoff semantics,
     and the no-configuration default.

## Test plan

Add a lightweight TypeScript test setup (the repository currently has no test
script) and unit-test the pure configuration/controller helpers with fake time
and fake model-registry results.

| Case | Expected result |
| --- | --- |
| No config, missing config, or empty array | Surplus is never replaced. |
| Ordered routes with matching models/auth | First healthy authenticated route is selected. |
| Missing model, missing key, invalid mapping | Route is skipped; next route or Surplus is used. |
| Preferred terminal error | Route cooldown is recorded and active model returns to Surplus. |
| Repeated errors | Delays grow exponentially, are capped, and jitter stays in the expected range. |
| Cooldown expiry | Preferred route is eligible again on a later request. |
| Preferred successful response | Failure count and cooldown reset. |
| Aborted response | No failure count or cooldown change. |
| Partial preferred output followed by error | No in-stream replay; next provider request uses Surplus. |
| Manual model switch | Non-Surplus selection clears status; extension never calls `pi.setModel`. |
| Reload/new/resume | State is reconstructed safely with no stale registry or model references. |
| pi-blackhole enabled | Existing bridge registration and Surplus background operation still work. |

Finally, run type checking/linting once a test toolchain is added, manually
exercise `/model`, a forced preferred-provider error, cooldown expiry, and
print/JSON modes, then verify that an unconfigured installation produces no
extra model changes or status output.

## Acceptance criteria

- Existing users with no `preferredProviders` setting observe no behavior
  change.
- Configured users start on the first healthy preferred route for each selected
  Surplus model.
- A preferred-provider terminal error returns model selection to Surplus and
  does not retry that route until its exponential-backoff cooldown expires.
- Later preferred success clears its accumulated failure state.
- Hotswap is transparent to Pi's model selection: the active Pi model stays on
  Surplus while the upstream request is routed to the preferred provider.
- Manual model choices and existing Surplus/pi-blackhole integrations remain
  intact.