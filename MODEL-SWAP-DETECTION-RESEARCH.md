# Model-Swap Detection Research

**Goal:** Detect and warn when the model actually serving a request is *not*
the model the caller selected — for example, when a savings-routing proxy
silently substitutes a cheaper/distilled model for the requested one.

**Why it matters here:** This extension routes through Surplus Intelligence's
`min50` route, which by design sends each request to whichever upstream
provider is cheapest at that moment. The preferred-provider hotswap feature
(`src/stream.ts`) goes further: it substitutes the upstream model entirely and
then rewrites `upstream.model = model.id` so Pi never sees the substitution. In
other words, **model identity is fluid by design in this stack**, and the only
thing the caller can trust is the bytes that come back.

Two harms motivate this work:
1. **Decreased performance** — a swap to a weaker model silently degrades
   reasoning, tool-use, and instruction-following quality.
2. **Unknowingly supporting unauthorized distillation** — if "Claude" is
   actually someone's distilled student, (a) your money flows to an IP thief,
   (b) your prompts/data may be handled by a less trustworthy operator, and
   (c) you are reinforcing a fraudulent supply chain. The repo is already aware
   of distillation as a threat (it requests reasoning *summaries* rather than
   raw traces "to avoid distillation" — see `src/stream.ts`).

> **Provenance & confidence.** This document is synthesized from domain
> knowledge of how frontier model families behave, plus the public literature
> directions on LLM fingerprinting/auditing, watermarking, and speculative
> decoding. No live model was probed to write it. Per-version behaviors drift,
> so every quirk below should be read as a **candidate signal to validate
> empirically** against a known-good baseline, not as a hard fact. Section 6
> covers drift and false positives explicitly.
>
> **Concrete evidence:** a model declared as `glm-5.2` self-identified as
> Claude-family during the development of this feature. See
> [`EVIDENCE-MODEL-MEDDLING.md`](EVIDENCE-MODEL-MEDDLING.md).

---

## 1. The detection problem (what is observable through a proxy)

Through Surplus you observe only:

| Observable | Usually available? | Spoofable by a malicious proxy? |
|---|---|---|
| Output text / thinking summary / tool calls | Always | Yes, cheaply (post-process, system prompt) |
| Declared `model` field in the response | Usually | Trivially (it's a string the proxy controls) |
| Per-token `logprobs` / `top_logprobs` | If requested (chat-completions *and* Responses API both support it) | Hard & expensive — requires actually running the claimed model |
| `usage` (token counts) | Usually | Mostly (can be recomputed/faked) |
| HTTP response headers / latency / throughput | Always | Partially (headers easy, latency/throughput hard to fake precisely) |
| Determinism at temperature 0 | Repeatable | Partially |

The strategic insight: **cheap-to-spoof signals (self-ID, declared model,
surface style) are weak; expensive-to-spoof signals (per-token logprobs,
tokenization behavior, hidden reasoning distribution) are strong.** A swap
detector should weight by cost-of-spoofing and combine many weak signals into
one likelihood ratio, because no single cheap signal survives an adversary.

---

## 2. Quirk taxonomy — fingerprint dimensions

Each dimension is rated **Strength** (how discriminating) and **Spoofability**
(how easily a malicious proxy hides it).

### 2.1 Tokenization fingerprints — Strength: **very high**, Spoofability: **low**

The single best cheap signal. Tokenizer behavior is baked into a model's
weights and shows up as systematic, characteristic failures on
character-aware tasks. A distillation student inherits the teacher's tokenizer
*imperfectly* and a different family outright fails differently.

- **The strawberry test** — "How many letter `r`s are in *strawberry*?"
  Historically a signature GPT-family failure (answering 2). Claude-family and
  Gemini-family have their own characteristic answers. The exact answer matters
  less than *consistency* with the baseline.
- **Letter-counting / spelling** — "How many letters in *indivisibility*?",
  "spell *restaurants* backwards", "what is the 4th letter of *xylophone*".
  These expose BPE merge boundaries vs. byte-level tokenizers.
- **Character-span rhyming / word games** — tasks that require per-character
  awareness; different tokenizers fail differently.

*Why it's hard to spoof:* faking it requires the proxy to detect the probe and
special-case the answer, which a generic swap operator won't do, and which
itself is detectable (probe the same fact phrased 5 ways and look for
inconsistent "fixing").

### 2.2 Per-token logprob signatures — Strength: **highest**, Spoofability: **very low** *(if logprobs are passed through)*

If logprobs reach you, you hold a near-unique fingerprint:

- **Anchor-text perplexity.** Run a fixed reference passage; each model assigns
  a characteristic per-token negative-log-likelihood distribution. Compute a
  scalar (mean NLL) + a distribution signature over the anchor. This is the
  basis of *linguistic/perplexity fingerprinting* and is extremely hard to fake
  without running the claimed model. **Capture the baseline once from a trusted
  direct call; alarm on divergence.**
- **Top-token preferences at fixed contexts.** Feed a fixed prompt prefix; the
  set of tokens a model strongly prefers vs. disprefers is distinctive.
- **Speculative-decoding artifacts.** Providers serving a teacher via
  speculative decoding (draft + verify) leak acceptance/rejection structure into
  logprob patterns. These artifacts can *identify the serving stack*, which is
  itself a swap signal.
- **Request `logprobs: true, top_logprobs: N`** on chat-completions and the
  Responses-API equivalent. This repo issues both endpoints, so both paths can
  carry logprobs through.

*Why it's hard to spoof:* to fabricate the *claimed* model's logprobs without
running it, the proxy would need a faithful local surrogate — which is exactly
the distillation problem and is never perfect.

### 2.3 Reasoning-trace fingerprints — Strength: **high**, Spoofability: **moderate** *(specifically relevant here)*

This repo already surfaces reasoning summaries (`include_reasoning: "summary"`).
Reasoning *style* is a strong, model-specific fingerprint:

- **Chain-of-thought phrasing** — OpenAI o/GPT-5-family summarized reasoning,
  Claude extended-thinking style, DeepSeek-R1 / Kimi reasoning style, and
  Gemini thinking each have distinctive cadences: use of "Wait," "Let me
  reconsider," self-correction density, step enumeration habits.
- **Reasoning length vs. effort** — token counts for a fixed task at a fixed
  `reasoning_effort` cluster by family.
- **Self-correction patterns** — whether/how a model catches its own mistakes
  mid-trace is hard for a student to reproduce faithfully.

A distilled student typically either (a) can't produce hidden reasoning at all,
(b) produces *plausible-looking but shallow* reasoning, or (c) leaks the
*teacher's* reasoning style imperfectly — all of which are detectable against a
baseline.

### 2.4 Verbal tics, formatting & style — Strength: **low–moderate**, Spoofability: **high**

Useful only as *corroborating* signals; easily mimicked with a system prompt.

- **Claude-family** tends toward hedged, first-person, structured responses;
  frequent em-dashes, "Here's…", careful scaffolding headers; a characteristic
  refusal register.
- **GPT-family** tendencies: "Certainly!"/"Sure!" openers, heavy **bold
  headers**, bullet lists, "As an AI…"-style framings (varies sharply by
  version).
- **Gemini-family** different markdown/emoji tendencies, "Here is/are…",
  "Understood," distinct refusal phrasing.
- **Kimi / DeepSeek / open-weight families** more terse or differently hedged;
  distinctive tool-call formatting.

Treat style as a *weak prior*, never a verdict.

### 2.5 Tool-call & structured-output fingerprints — Strength: **moderate–high**, Spoofability: **moderate**

This repo routes tool calls (`src/responses-tools.ts`). Tool-call shape is
observable and fairly family-distinct:

- Argument ordering, handling of optional/missing args, JSON-quoting habits,
  how the model names/sequences multiple tool calls, and error-recovery
  behavior all vary by family.
- Adherence to a strict schema vs. free-form args.

### 2.6 Refusal & safety behavior — Strength: **moderate**, Spoofability: **moderate**

Each lab's safety posttraining imposes distinct refusal *styles* and
*thresholds*. A swapped model often shows a different refusal register or a
different trigger threshold on carefully constructed edge prompts.

- **Memorization/copyright continuation** — different labs train on / block
  different copyrighted text; asking for continuations of well-known passages
  elicits lab-distinct refusal-vs-comply behavior.
- **Refusal wording** on borderline requests is a soft fingerprint.

*Caveat:* probing safety boundaries is ethically and ToS-sensitive. Prefer the
memorization-style benign probes.

### 2.7 Capability cliffs & signature errors — Strength: **moderate**, Spoofability: **moderate**

Every frontier model has known signature weaknesses (specific math failures,
hallucinations, code-language preferences, formatting glitches). A distilled
student inherits *some* teacher errors but loses subtle ones and introduces
new ones. A small battery of "stratifying" micro-tasks (where model families
separate) yields a capability profile.

### 2.8 Self-identification & knowledge cutoff — Strength: **low**, Spoofability: **very high**

- "What model are you?" / "When is your training cutoff?" — the weakest signal.
  Models are RLHF'd to disclaim or to parrot config, and a proxy can set a
  system prompt to force any answer. **Do not rely on this**; use only as a
  sanity check that, if it *contradicts* the expected family, raises a flag.

### 2.9 Metadata & transport signals — Strength: **moderate**, Spoofability: **low (headers) / mixed (latency)**

- **HTTP headers** — `server`, `via`, `x-*` provider headers, rate-limit
  headers, `cf-ray`/Cloudflare signatures. Different upstreams leak different
  headers; unexpected header sets are a swap signal.
- **Latency / throughput / TTFB distributions** — each upstream has a
  characteristic timing profile. Stable across a session; hard to fake
  precisely.
- **Usage accounting quirks** — how cache-read tokens, reasoning tokens, and
  total tokens are reported varies by upstream and can contradict the declared
  model.
- **Determinism check** — two identical prompts at temperature 0 from the
  *same* real model are usually near-identical; cross-provider or cross-rev
  swaps produce divergence.

---

## 3. Cross-cutting cheat-sheet

| Signal | Strength | Spoof cost | Needs logprobs? | This repo can see it? |
|---|---|---|---|---|
| Tokenization (strawberry et al.) | very high | low | no | ✅ text |
| Anchor-text perplexity | highest | very high | **yes** | ✅ if requested |
| Top-token preferences | highest | very high | **yes** | ✅ if requested |
| Spec-decode logprob artifacts | high | high | **yes** | ✅ if requested |
| Reasoning-trace style | high | moderate | no | ✅ (summary surfaced) |
| Tool-call shape | moderate–high | moderate | no | ✅ |
| Safety/refusal register | moderate | moderate | no | ✅ |
| Signature errors / capability | moderate | moderate | no | ✅ |
| Transport headers / latency | moderate | mixed | no | ✅ |
| Self-ID / cutoff | low | trivial | no | ✅ but weak |
| Verbal style | low–moderate | high | no | ✅ but weak |

**Recommended portfolio:** lead with (1) anchor-text perplexity whenever
logprobs are available, (2) a tokenization probe battery, (3) reasoning-style
signature when reasoning is on — and use everything else as cheap corroborating
votes.

---

## 4. Detection design tailored to this codebase

The infrastructure is already half-built. The plan is to extend the existing
diagnostic-and-warn plumbing rather than invent a new path.

### 4.1 Baseline capture (trusted-direct path)
The preferred-provider hotswap feature already has *direct* upstream paths.
Reuse them: when a model is first used through a **trusted direct route** (not
the min50 savings route), capture a fingerprint profile and persist it (e.g.,
alongside `.pi/surplus-intelligence.json`):

```
profile = {
  modelId, capturedAt, provider,
  anchorPerplexity,          // from a fixed reference passage, needs logprobs
  tokenization: { strawberry, indivisibilityCount, spellRestaurantsBackwards },
  reasoningSignature,        // style/length hash, when reasoning available
  toolCallShape,             // from a fixed tool-use probe
  latencyProfile,            // TTFB + throughput stats
  headerAllowlist,           // observed header keys/values
}
```

### 4.2 Per-session / per-response lightweight checks
On each response (or a sampling of responses), compute a subset cheaply:

- Re-run the **tokenization battery** periodically (a few tokens of overhead).
- If logprobs were requested, compute **anchor perplexity delta** vs. baseline.
- Check **declared `model` vs. requested** (already captured as `responseModel`).
- Check **header set** against the baseline allowlist.
- Compare **reasoning style/length** to the baseline distribution.

### 4.3 Score & warn (reuse the existing pattern)
Combine signals into a confidence score (likelihood-ratio / weighted vote).
On a low-confidence match, emit a diagnostic and surface a warning via the
**exact pattern already used** in `index.ts`:

```ts
ctx.ui.notify(diagnostic, "warning");
```

and attach a `model_fingerprint` diagnostic alongside the existing
`preferred_upstream` diagnostic in `src/stream.ts` (where `responseModel` is
already being set):

```ts
const diagnostic: AssistantMessageDiagnostic = {
  type: "model_fingerprint",
  timestamp: Date.now(),
  details: { matchConfidence, flags: [...], declaredModel, expectedModel },
};
```

### 4.4 The "two kinds of swap" distinction (important)
The detector must distinguish:
1. **Legitimate lab update** — Anthropic/OpenAI silently rev a model; the
   fingerprint drifts *gradually* and *consistently* across all routes for that
   model id. → Low-urgency informational notice ("model appears updated").
2. **Proxy swap to a different model** — fingerprint matches a *different*
   family, or is *inconsistent across requests* (because min50 routes to
   different upstreams each time). → High-urgency warning.

The signature of a savings-routing swap is specifically **inconsistency**: the
same `model.id` producing different fingerprints across requests, because each
request hits a different cheap upstream. This is detectable even without a
trusted baseline, by measuring **intra-session fingerprint variance**.

---

## 5. A practical probe battery (concrete)

Validate these empirically per model id, then keep the answers as the baseline.
All are benign and cheap.

**Tokenization (strong):**
- "Count the letter `r` in `strawberry`. Answer with just the number."
- "How many letters are in `indivisibility`?"
- "Spell `restaurants` backwards, one letter per character."
- "What is the 5th letter of `xylophone`?"

**Anchor text (strongest, needs logprobs):** a fixed ~64-token public-domain
passage (e.g., a Project Gutenberg opening). Record per-token NLL + top-token
preferences.

**Reasoning style (when reasoning on):** a fixed multi-step word problem; record
summary length, step phrasing, self-correction count.

**Capability stratifiers:** a handful of short math/code/word tasks where model
families separate; record pass/fail + exact errors.

**Transport:** log response headers + TTFB/throughput per response.

**Self-ID / cutoff (weak, sanity only):** "What model are you, and what is your
knowledge cutoff?"

---

## 6. Limitations & adversarial considerations

- **A determined proxy can:** post-process output, spoof self-ID, mimic surface
  style with a system prompt, strip/rewrite metadata headers, and fake usage.
  **It cannot cheaply:** fabricate a *different* model's per-token logprobs,
  faithfully fake a tokenizer's behavior across many phrasings, or perfectly
  reproduce a hidden reasoning distribution.
- **Determinism is fuzzy.** Temperature 0 is not bit-identical across inference
  stacks or even across replicas of the same model. Use multiple samples and
  statistics (mean/variance), not single-shot equality.
- **Drift vs. swap.** Frontier models get silently updated by their own labs —
  a *legitimate* event. Fingerprints must be versioned and tolerant; alarms
  should separate "this family, but a new revision" from "a different family."
- **False positives erode trust.** Calibrate thresholds; prefer informational
  notices for ambiguous drift and reserve hard warnings for cross-family /
  high-inconsistency cases.
- **Logprob availability is the keystone.** If Surplus strips or recomputes
  logprobs, the strongest signals weaken; then lean harder on tokenization +
  reasoning-style + intra-session variance.
- **Watermarking is a complementary oracle.** Some providers embed statistical
  watermarks (e.g., Google DeepMind's *SynthID-Text*; OpenAI explored and later
  deprecated a text watermark classifier). Detecting a known watermark *proves*
  origin; its absence proves little. Treat watermark detection as a bonus
  positive signal, not a primary detector.

---

## 7. Related work (directions, not exhaustive)

These are established *research directions*; exact titles/dates should be
verified before citing in external writing, but the bodies of work are real:

- **LLM / perplexity fingerprinting** — using per-token logprob distributions and
  anchor-text perplexity as a model-identifying signature.
- **Speculative-decoding artifact analysis** — detecting draft/verify structure
  leaked through logprobs, which can identify the serving stack.
- **Statistical watermarking** — *SynthID-Text* (Google DeepMind) embeds and
  detects watermarks without quality loss; relevant as an origin oracle.
- **LLM auditing / "are you getting what you paid for?"** — work on verifying
  that a served model matches its advertised identity, including through API
  aggregators/routers (the exact Surplus/OpenRouter threat model).
- **Stylometry of generated text** — authorship-style attribution applied to
  model families (weak signal, easily perturbed).
- **Model distillation attribution** — detecting whether a model is a distilled
  copy of another, increasingly relevant to the unauthorized-distillation harm.

---

## 8. Current status & next steps

Implemented (see `MODEL-SWAP-FINGERPRINT-PLAN.md`):

1. **Inline fingerprint diagnostic** — `src/fingerprint.ts` extracts §2.3/§2.4/§2.5
   features and emits a `model_fingerprint` `AssistantMessageDiagnostic` on
   every `done` event in `src/stream.ts`.
2. **Warnings wired** — cross-family mismatches surface via the existing
   `ctx.ui.notify(..., "warning")` path, deduplicated per session.
3. **Probe harness / tests** — `test/fingerprint.test.ts` exercises feature
   extraction, matching thresholds, and tunability.

Still to do:

4. **Empirical baseline capture** — add a one-time probe run over the direct
   preferred-provider paths (which are trusted) to populate per-model profiles
   from real samples, replacing the current synthesized priors.
5. **Logprob pass-through** — confirm whether Surplus forwards `logprobs`/
   `top_logprobs` on both the chat-completions and Responses paths; if so,
   enable anchor-perplexity capture (§2.2, the strongest signal). If not,
   document the degraded mode.
6. **Variance monitor** — track intra-session fingerprint variance per
   `model.id` and warn when it exceeds threshold (catches min50 multi-upstream
   swaps without any baseline).
7. **Config override** — allow profile/weight overrides from
   `.pi/surplus-intelligence.json` so users can tune without editing code.

---

*Author: synthesized research note. All model-family behaviors are
version-dependent and must be validated against live models before being used
as hard detection rules. The strongest, least-spoofable signals require logprob
pass-through from the upstream.*