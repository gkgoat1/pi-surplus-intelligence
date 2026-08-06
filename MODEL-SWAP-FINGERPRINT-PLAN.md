# Model-Swap Fingerprint Plan

Implements the first slice of model-swap detection for the Surplus Intelligence
extension: the cheap, human-visible, deterministic signals from
`MODEL-SWAP-DETECTION-RESEARCH.md` §2.3 (reasoning-trace style), §2.4 (verbal
tics / formatting), and §2.5 (coarse tool-call shape).

## Goal

Every assistant response that flows through `src/stream.ts` gets a lightweight
fingerprint diagnostic attached to the final `AssistantMessage`. If the
response's visible style clearly belongs to a *different* model family than the
one selected, Pi shows a one-time warning. The warning is human-verifiable: the
diagnostic names the concrete features (em-dashes, "Certainly!", etc.) that
voted for the mismatch.

This slice intentionally does **not** use per-token logprobs or tokenizer
probes (§2.1/§2.2) — those are stronger but require either logprob pass-through
or dedicated probe requests. They are the next layer.

## Files

- `src/fingerprint.ts` — pure module: feature extraction, family profiles,
  matching, diagnostic/warning generation, and session-scope UI delivery.
- `src/stream.ts` — calls `analyzeResponse()` on every `done` event and
  appends the resulting `model_fingerprint` diagnostic.
- `index.ts` — registers the fingerprint session scope so warnings can reach
  `ctx.ui.notify(..., "warning")`.
- `test/fingerprint.test.ts` — unit/integration tests for extraction, matching,
  warning thresholds, and tunability.

## Feature set

`extractFeatures()` turns the assistant message's content blocks into a numeric
vector. Rates are per 1000 characters unless noted.

| Feature | Source | What it captures |
|---|---|---|
| `emDashDensity` | text | U+2014 count (Claude signature) |
| `exclaimOpener` | text | "Certainly!"/"Sure!" openers (GPT-leaning) |
| `boldHeaderDensity` | text | whole-line `**...**` headings |
| `mdHeaderDensity` | text | markdown `#` headings |
| `bulletDensity` | text | `-` / `*` / `•` list lines |
| `emojiDensity` | text | pictographic emoji |
| `phraseDensityGpt` | text | GPT-tell phrases per family phrase list |
| `phraseDensityClaude` | text | Claude-tell phrases |
| `phraseDensityGemini` | text | Gemini-tell phrases |
| `reasoningTicDensity` | thinking | "wait"/"let me"/"step"/"actually" etc. |
| `selfCorrectionDensity` | thinking | "wait,"/"actually,"/"let me reconsider" etc. |
| `stepEnumerationDensity` | thinking | numbered steps / "first"/"finally" |
| `multiToolBatch` | tool calls | more than one tool call in one turn |

Style features are only weighted when the visible text is at least
`MIN_TEXT_CHARS` (120). Reasoning features are only weighted when the thinking
summary is at least `MIN_REASONING_CHARS` (160). If neither threshold is met,
`analyzeResponse()` returns `undefined` — we refuse to fingerprint noise.

## Matching math

For each feature `i` with measured value `x_i` and a per-family expected value
`μ_f` with scale `σ_f`:

```
z_i_f = min(|x_i - μ_f| / σ_f, Z_CAP)   # Z_CAP = 3
contribution_i_f = weight_i * z_i_f
distance(f) = Σ contribution_i_f
```

The response is classified as `argmin distance(f)`. A warning is emitted when:

- the predicted family differs from the expected family, and
- `margin = distance(expected) - distance(predicted)` clears `WARN_MARGIN`
  (currently 3.0 weighted-z units).

The `confidence` percentage is `margin / (distance(expected) + distance(predicted))`.

## Tuning surface

The profiles are data-driven and easy to adjust without touching the
extraction or matching code:

1. **`DEFAULT_PROFILES[family].features[name].expected`** — the central value
   the family is expected to have for that feature.
2. **`DEFAULT_PROFILES[family].features[name].scale`** — the spread; larger
   means the feature is less discriminating for that family.
3. **`FEATURE_WEIGHTS[name]`** — global per-feature contribution. Set to `0` to
   disable a feature entirely.
4. **Phrase lists** — `PHRASES.gpt`, `PHRASES.claude`, `PHRASES.gemini` in
   `src/fingerprint.ts`.
5. **Constants** — `MIN_TEXT_CHARS`, `MIN_REASONING_CHARS`, `WARN_MARGIN`,
   `Z_CAP`.

To calibrate from real samples:

1. Collect a few representative responses from a *trusted direct* route for
   each model you care about.
2. Run `extractFeatures()` on them (or inspect the `details.features` field of
   the `model_fingerprint` diagnostic that is already being emitted).
3. Update the corresponding family's `expected` and `scale` values to match the
   observed distribution.
4. If a feature is noisy for a family, increase its `scale` or lower its
   `FEATURE_WEIGHTS`.
5. Add a test in `test/fingerprint.test.ts` with a controlled vector or a
   representative fixture.

## Current limitations

- **Real incident observed.** During development, a model declared as
  `glm-5.2` produced output that self-identified as Claude-family. See
  [`EVIDENCE-MODEL-MEDDLING.md`](EVIDENCE-MODEL-MEDDLING.md).
- **Tool-call formatting is lost.** By the time we see the parsed `ToolCall`
  block, argument JSON has already been normalized. The only deterministic
  inline signals left are call count and batching. Raw payload fingerprinting
  requires hooking the response body earlier (future work).
- **Style is spoofable.** A malicious proxy can add a system prompt saying
  "always start with Certainly!" or "use em-dashes." These signals are
  therefore treated as corroborating evidence, not proof. They catch the
  common case of an unsophisticated swap or an imperfect distillation student.
- **No baseline capture yet.** Right now every response is compared to the
  static `DEFAULT_PROFILES`. The next phase will capture per-model baselines from
  trusted direct routes and compare responses to those baselines.
- **No config override yet.** Profiles live in code. A future `.pi/*.json`
  config override will let projects tune without forking the extension.

## Wiring

`src/stream.ts` runs this on every `done` event:

```ts
const fingerprint = analyzeResponse(finalOutput, model.id);
if (fingerprint?.diagnostic) {
	finalOutput.diagnostics = [...(finalOutput.diagnostics ?? []), fingerprint.diagnostic];
	if (fingerprint.warning && fingerprint.warningKey) {
		notifyFingerprintWarning(options?.sessionId, fingerprint.warningKey, fingerprint.warning);
	}
}
```

`finalOutput` is the same object referenced by `doneEvent.message`, so the
diagnostic appears downstream without rebuilding the event.

Warnings are deduplicated per `(expected|predicted)` pair within a session,
so a persistent swap warns once rather than spamming every turn.

## Tests

`test/fingerprint.test.ts` covers:

- Family resolution from model ids.
- Exact feature extraction counts (em-dashes, exclamation opener, bold headers,
  bullets, phrase densities).
- Matching machinery: a vector built from a family's expected profile is
  classified as that family.
- Cross-family mismatch: a Claude-shaped vector under expected `gpt` clears
  `WARN_MARGIN`.
- End-to-end `analyzeResponse`: a Claude-style fixture served under a GPT model
  id produces a warning; the same fixture under a Claude model id does not.
- Short text / unknown family return `undefined`.
- Tunability: swapping profiles reclassifies the same vector; zeroing weights
  removes feature influence.

## Next steps

1. **Config override** — load profile overrides from
   `.pi/surplus-intelligence.json` so users can tune without editing code.
2. **Trusted baseline capture** — when a model is used through a direct
   preferred-provider route, record its observed fingerprint distribution and
   use that as the comparison baseline.
3. **Intra-session variance monitor** — detect when the same `model.id` produces
   inconsistent fingerprints across requests (the signature of min50 multi-
   upstream swaps).
4. **Stronger signals** — request and analyze per-token logprobs and add
   tokenizer probes (strawberry test, spelling backwards) when feasible.