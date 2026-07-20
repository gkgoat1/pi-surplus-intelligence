# Thinking Compression Plan for Pi Surplus Intelligence

## Goal

Add an opt-in Surplus Intelligence feature that compresses eligible upstream
assistant thinking through a separately resolved Pi model **inside the native Pi
stream path**. The selected Pi model remains `surplus-intelligence/...`; only
the generation stream is wrapped. The final assistant message retains a concise
thinking representation so subsequent turns send fewer reasoning tokens to
open-weight models.

This plan complements the framework design in
[`../agym/thinking-compression-plan.md`](../agym/thinking-compression-plan.md).
It does not replace the existing preferred-provider hotswap: preferred-provider
routing chooses the model that produces the response; thinking compression
post-processes only that response when it is eligible.

## Safety model

Compression is disabled by default and must fail closed.

Only all of the following may be compressed:

- text emitted as an assistant `thinking` content block or a known unsigned
  OpenAI-compatible reasoning field;
- reasoning from a source model explicitly configured as eligible (initially,
  an allowlist of open-weight models/routes);
- reasoning that has no signature, encrypted payload, opaque reasoning token,
  or provider-required replay/integrity metadata;
- content above the configured threshold and within the feature's time/token
  budget.

Never compress, strip, or reserialize:

- a thinking block with `thinkingSignature` (including an empty-but-present
  signature when provider semantics require it);
- encrypted reasoning, provider continuation tokens, hidden reasoning IDs, or
  unknown reasoning formats;
- assistant visible text, tool calls, tool results, system/developer/user
  content, or Pi session entries;
- the existing Surplus `include_reasoning: "summary"` result when the source
  cannot be proved mutable.

If detection, model resolution, compression, or validation fails, retain the
original message unchanged. The compressor receives no Pi auth store, preferred
provider config, or general session transcript.

## Configuration contract

Use a trusted, project-local file:

```text
.pi/surplus-intelligence-thinking-compression.json
```

Example:

```json
{
  "enabled": true,
  "sources": [
    {
      "provider": "surplus-intelligence",
      "model": "open-weight-reasoner",
      "allowUnsignedThinking": true
    }
  ],
  "compressor": {
    "provider": "openrouter",
    "model": "meta-llama/llama-3.3-70b-instruct",
    "maxOutputTokens": 400,
    "timeoutMs": 8000
  },
  "minimumThinkingTokens": 700,
  "minimumSavingsRatio": 0.35,
  "streaming": "buffer-thinking",
  "onError": "passthrough"
}
```

Validation rules:

- `enabled` defaults to `false`.
- `sources` is a required non-empty allowlist when enabled; no wildcard source
  routes in the first release.
- Compressor provider/model must resolve through `ctx.modelRegistry`, be
  distinct from the selected source route, and have configured authentication.
- The compressor model must be explicitly allowed by configuration. It is not
  silently selected from current/default/preferred models.
- Reject invalid sizes, a zero timeout, source/compressor equality, duplicate
  routes, and unknown enum values with one rate-limited diagnostic; proceed
  with feature disabled.
- Read only when `ctx.isProjectTrusted()` is true. Missing config is not an
  error.
- `onError` is fixed to `passthrough` initially. A future lossy/drop mode
  requires a distinct, prominently named opt-in and is out of scope.

Keep configuration state in a `Symbol.for(...)` global object, like
`preferred-providers.ts`, so reloads and subinvocations do not lose a live
circuit-breaker/cooldown. Session-scoped fields hold only the current trusted
config, registry, mode, and UI reference. Never retain old `Context`,
`AbortSignal`, assistant messages, or credentials globally.

## Native Pi implementation

### Stream wrapper changes

`src/stream.ts` already owns `createSurplusStreamSimple` and wraps either
`streamPreferredRoute(...)` or Pi's built-in OpenAI-completions stream. Extend
that wrapper after route selection:

1. Resolve the actual source identity: selected Surplus model plus any
   `PreferredRoute` model. Do not base eligibility on the display model alone.
2. Start the existing upstream stream normally and preserve preferred-route
   success/failure bookkeeping.
3. Accumulate only candidate thinking events/blocks. Forward normal text and
   tool-call events untouched.
4. At `done`, inspect the final `AssistantMessage.content` and its reasoning
   metadata for a provably unsigned, plaintext candidate.
5. Resolve the configured compressor through `ctx.modelRegistry.runtime` and
   call its `streamSimple` with a deliberately constructed compression context:
   no tools, no inherited tool results beyond bounded task context, thinking
   off when supported, fresh `sessionId`/request metadata, and the active
   abort signal.
6. Collect a strict JSON response such as
   `{ "thinking": "..." }`; reject text/tool-call output, malformed output,
   and a result that does not meet the configured savings threshold.
7. Replace only the eligible `thinking` content block text; retain its content
   index, all normal content, provider/model attribution, and any untouched
   blocks exactly. Update usage/diagnostics with separate source and compressor
   accounting without pretending the original provider reported compressed
   token usage.
8. Emit `thinking_start`/`thinking_delta`/`thinking_end` for the replacement,
   then emit the original terminal `done` with the updated final message.

Avoid `pi.setModel`, `pi.sendMessage`, and a nested `AgentSession`. Dispatch
through the runtime's `streamSimple` exactly as preferred-provider routing does.
That makes compressor routing compatible with Pi provider APIs and custom
streams while keeping the active model stable.

### Streaming policy

Implement `buffer-thinking` first. Never forward eligible raw thinking deltas
that may later be replaced. Visible text and tool calls can pass through when
Pi event ordering permits; otherwise buffer the whole response for enabled
requests. Track the extra terminal latency in diagnostics/status.

For an ineligible block, immediately preserve/forward existing behavior. Do
not assume that every `thinking_delta` is mutable merely because Pi surfaced
it. The stream wrapper must check finalized content metadata before deciding.

### Hooks and UI

Wire feature state in `index.ts`:

- `session_start`: load/reload trusted config and capture `modelRegistry`;
- `before_agent_start`, `model_select`: refresh an interactive-only footer
  status such as `Thinking compression: OpenRouter Llama (eligible)` or
  `Thinking compression: pass-through (signed)`;
- `thinking_level_select`: refresh status but do not change the user's level;
- `message_end`: a final guard that checks compressed messages retain valid
  assistant shape and normalizes recognized compressor overflow failures to
  pass-through, never compaction;
- `session_shutdown`: clear UI/session references and abort only feature-owned
  pending work.

Do not emit status or diagnostics to print, JSON, or RPC output. Use a custom
assistant diagnostic (for example `thinking_compression`) with redacted fields:
source/compressor IDs, eligibility decision, source/compressed token estimates,
compressor token usage, and duration. Do not store raw original thinking in
`details`, custom entries, logs, or diagnostics.

### Compressor prompt and context

Use a fixed, schema-constrained prompt. It asks for a compact internal
continuation memo containing relevant decisions, constraints, uncertainty, and
next-step context. It must not expose chain-of-thought, imitate the user,
produce a final answer, create tool calls, or include credentials. Bound the
input to the eligible thinking and, at most, the latest user text plus already
visible assistant text. Exclude system prompts, tool outputs, images, and prior
thinking by default.

Set an abort-aware timeout. Ensure source/compressor calls have recursion
protection so a compressor route cannot itself enter the Surplus thinking
compression wrapper.

## Files and phases

### Phase 1 — Types/configuration

- [ ] Add `src/thinking-compression.ts` for config parsing, trusted loading,
  route resolution, eligibility, circuit breaker, status, and diagnostics.
- [ ] Extend `src/types.ts` with narrow runtime helper types and compression
  result/diagnostic types; avoid broad `any` casts around assistant blocks.
- [ ] Unit-test parser, trusted/missing config behavior, source allowlist,
  signed/encrypted rejection, threshold/savings checks, and cooldown.

### Phase 2 — Compressor dispatch

- [ ] Add a runtime-based compressor dispatcher modeled on
  `streamPreferredRoute`, but with isolated request options and recursion
  guard.
- [ ] Implement event collection and strict structured-output parsing.
- [ ] Test cancellation, timeout, empty/invalid result, tool-call result, and
  provider error all preserve original thinking.

### Phase 3 — Response/stream integration

- [ ] Refactor `createSurplusStreamSimple` into small source-stream, candidate
  collection, and terminal-rewrite helpers.
- [ ] Implement the buffered-thinking event sequence and final-message rewrite.
- [ ] Preserve existing preferred-route attribution, route health, Surplus
  reasoning-token fallback, and pi-blackhole bridge behavior.
- [ ] Add stream fixture tests for text, thinking, mixed content, tools, and
  terminal errors.

### Phase 4 — Operations and documentation

- [ ] Add README configuration/security guidance and an example disabled config.
- [ ] Add `/surplus-thinking-compression` inspection command only if it can
  avoid raw-thinking display; otherwise rely on status/diagnostics.
- [ ] Manually validate TUI, print, JSON, RPC, `/reload`, `/new`, `/resume`,
  preferred-provider hotswap, and pi-blackhole paths.

## Acceptance criteria

- An unconfigured installation has no behavioral, payload, latency, or model
  selection change.
- A configured eligible open-weight source retains a shorter thinking block in
  the final assistant message and next-turn context.
- Signed, encrypted, unknown, or provider-replay thinking is never sent to the
  compressor or altered.
- Compressor failures and cancellation safely return the original stream/result.
- The active Pi model remains Surplus, preferred-provider hotswap still works,
  and the compressor is invoked through Pi's native model runtime rather than
  an ad hoc HTTP client.
- Logs/diagnostics expose aggregate measurements only, never raw reasoning or
  credentials.