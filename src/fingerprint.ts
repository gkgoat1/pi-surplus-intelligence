/**
 * Inline model-swap fingerprinting for Surplus Intelligence responses.
 *
 * Surplus routes each request to the cheapest upstream that meets the savings
 * floor, and the preferred-provider hotswap substitutes the upstream model
 * entirely. Either path can serve a *different* model than the one selected.
 * This module computes a cheap, deterministic, human-verifiable fingerprint
 * from the response's visible text, reasoning summary, and tool calls, and
 * compares it to the family expected for the requested model id.
 *
 * Scope of this module: the three cheapest, most human-visible signals from
 * MODEL-SWAP-DETECTION-RESEARCH.md — §2.3 reasoning-trace style, §2.4 verbal
 * tics / formatting, and §2.5 tool-call shape. These are weak-to-moderate
 * individually (a determined proxy can mimic surface style) but cheap, inline,
 * and — crucially — easy for a human to verify by glancing at the output.
 * Stronger, harder-to-spoof signals (per-token logprobs, tokenizer probes)
 * are layered on later.
 *
 * Tuning surface: `DEFAULT_PROFILES` (per-family expected value + scale for
 * each feature) and `FEATURE_WEIGHTS` (global per-feature contribution) are
 * the knobs. `extractFeatures` / `matchFingerprint` / `analyzeResponse` all
 * accept an optional profiles override so baselines derived from real samples
 * can be dropped in without touching the extractor.
 */
import type { AssistantMessageDiagnostic, ProviderId } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Families & feature vocabulary
// ---------------------------------------------------------------------------

/** Model families this router commonly serves and that we can profile. */
export type ModelFamily = "claude" | "gpt" | "gemini" | "kimi" | "deepseek";

/** Family-distinctive phrase lists, used to compute the per-family phrase
 *  density features. Case-insensitive substring matches. Tunable. */
const PHRASES: Record<"gpt" | "claude" | "gemini", string[]> = {
	gpt: [
		"certainly", "of course", "sure, i", "absolutely", "great question",
		"happy to help", "feel free to", "as an ai", "it's important to note",
		"i hope this helps", "let me know if", "i'd be happy to help",
	],
	claude: [
		"i'd be happy to", "here's", "let me", "i'll", "a few things",
		"a couple of", "i'd be glad", "to summarize", "a few considerations",
		"let's", "i want to", "a few notes",
	],
	gemini: [
		"understood", "here is", "here are", "let's break this down",
		"i can certainly", "sure thing", "absolutely, here",
	],
};

/** Discriminating features. Rates are per 1000 characters unless noted. */
type FeatureName =
	// §2.4 style (from visible text)
	| "emDashDensity" // U+2014 count / 1k chars (Claude signature)
	| "exclaimOpener" // 0|1: "Certainly!" / "Sure!" style opener (GPT-leaning)
	| "boldHeaderDensity" // whole-line **bold** headings / 1k chars
	| "mdHeaderDensity" // markdown # headings / 1k chars
	| "bulletDensity" // - * • list lines / 1k chars
	| "emojiDensity" // pictographic emoji / 1k chars
	| "phraseDensityGpt" // GPT telltale phrases / 1k chars
	| "phraseDensityClaude" // Claude telltale phrases / 1k chars
	| "phraseDensityGemini" // Gemini telltale phrases / 1k chars
	// §2.3 reasoning (from thinking summary)
	| "reasoningTicDensity" // "wait"/"let me"/"so," etc. / 1k chars
	| "selfCorrectionDensity" // "wait,"/"actually,"/"hmm" / 1k chars
	| "stepEnumerationDensity" // "1."/"first"/"second"/"finally" / 1k chars
	// §2.5 tool-call shape (coarse; raw formatting is lost by parse time)
	| "multiToolBatch"; // 0|1: more than one tool call in one message

const STYLE_FEATURES: FeatureName[] = [
	"emDashDensity", "exclaimOpener", "boldHeaderDensity", "mdHeaderDensity",
	"bulletDensity", "emojiDensity", "phraseDensityGpt", "phraseDensityClaude", "phraseDensityGemini",
];
const REASONING_FEATURES: FeatureName[] = [
	"reasoningTicDensity", "selfCorrectionDensity", "stepEnumerationDensity",
];
const ALL_FEATURES: FeatureName[] = [...STYLE_FEATURES, ...REASONING_FEATURES, "multiToolBatch"];

/** Global per-feature contribution to the distance score. 0 disables a feature. */
export const FEATURE_WEIGHTS: Record<FeatureName, number> = {
	emDashDensity: 1.5,
	exclaimOpener: 1.2,
	boldHeaderDensity: 1.0,
	mdHeaderDensity: 0.6,
	bulletDensity: 0.5,
	emojiDensity: 0.8,
	phraseDensityGpt: 1.3,
	phraseDensityClaude: 1.3,
	phraseDensityGemini: 1.0,
	reasoningTicDensity: 1.0,
	selfCorrectionDensity: 0.8,
	stepEnumerationDensity: 0.7,
	multiToolBatch: 0.4,
};

/** Human-readable labels for the flags surfaced in diagnostics/warnings. */
export const FEATURE_LABELS: Record<FeatureName, string> = {
	emDashDensity: "em-dash density (per 1k chars)",
	exclaimOpener: "exclamation opener (\"Certainly!\"/\"Sure!\")",
	boldHeaderDensity: "bold **headings** (per 1k chars)",
	mdHeaderDensity: "markdown # headings (per 1k chars)",
	bulletDensity: "bullet lists (per 1k chars)",
	emojiDensity: "emoji (per 1k chars)",
	phraseDensityGpt: "GPT-style phrases (per 1k chars)",
	phraseDensityClaude: "Claude-style phrases (per 1k chars)",
	phraseDensityGemini: "Gemini-style phrases (per 1k chars)",
	reasoningTicDensity: "reasoning tics (per 1k chars)",
	selfCorrectionDensity: "self-corrections in reasoning (per 1k chars)",
	stepEnumerationDensity: "step enumeration in reasoning (per 1k chars)",
	multiToolBatch: "multiple tool calls in one turn",
};

type FeatureSpec = { expected: number; scale: number };
export type FamilyProfile = { family: ModelFamily; features: Record<FeatureName, FeatureSpec> };

// ---------------------------------------------------------------------------
// Default profiles
// ---------------------------------------------------------------------------
// Starting estimates synthesized from each family's characteristic output.
// These are NOT calibrated against live models — treat them as priors to be
// refined from real samples (see MODEL-SWAP-FINGERPRINT-PLAN.md). `scale` is a
// per-feature standard-deviation-like spread: larger = the feature discriminates
// less for that family. Every family must specify every feature so distances
// stay comparable across families.
// ---------------------------------------------------------------------------

function profile(family: ModelFamily, features: Record<FeatureName, FeatureSpec>): FamilyProfile {
	return { family, features };
}

export const DEFAULT_PROFILES: Record<ModelFamily, FamilyProfile> = {
	claude: profile("claude", {
		emDashDensity: { expected: 5.0, scale: 2.5 }, // strong Claude signature
		exclaimOpener: { expected: 0.1, scale: 0.3 },
		boldHeaderDensity: { expected: 0.3, scale: 0.5 },
		mdHeaderDensity: { expected: 0.6, scale: 0.8 },
		bulletDensity: { expected: 1.2, scale: 1.0 },
		emojiDensity: { expected: 0.05, scale: 0.2 },
		phraseDensityGpt: { expected: 0.3, scale: 0.6 },
		phraseDensityClaude: { expected: 4.0, scale: 2.0 },
		phraseDensityGemini: { expected: 0.3, scale: 0.6 },
		reasoningTicDensity: { expected: 2.0, scale: 1.6 },
		selfCorrectionDensity: { expected: 1.0, scale: 1.0 },
		stepEnumerationDensity: { expected: 1.0, scale: 1.0 },
		multiToolBatch: { expected: 0.3, scale: 0.4 },
	}),
	gpt: profile("gpt", {
		emDashDensity: { expected: 0.8, scale: 1.0 },
		exclaimOpener: { expected: 0.6, scale: 0.5 },
		boldHeaderDensity: { expected: 2.0, scale: 1.2 },
		mdHeaderDensity: { expected: 1.0, scale: 1.0 },
		bulletDensity: { expected: 2.0, scale: 1.2 },
		emojiDensity: { expected: 0.6, scale: 0.8 },
		phraseDensityGpt: { expected: 5.0, scale: 2.5 },
		phraseDensityClaude: { expected: 0.5, scale: 0.6 },
		phraseDensityGemini: { expected: 0.5, scale: 0.6 },
		reasoningTicDensity: { expected: 1.5, scale: 1.2 },
		selfCorrectionDensity: { expected: 0.8, scale: 0.8 },
		stepEnumerationDensity: { expected: 1.5, scale: 1.0 },
		multiToolBatch: { expected: 0.5, scale: 0.5 },
	}),
	gemini: profile("gemini", {
		emDashDensity: { expected: 0.6, scale: 0.8 },
		exclaimOpener: { expected: 0.2, scale: 0.4 },
		boldHeaderDensity: { expected: 1.2, scale: 1.0 },
		mdHeaderDensity: { expected: 1.0, scale: 1.0 },
		bulletDensity: { expected: 1.8, scale: 1.2 },
		emojiDensity: { expected: 1.0, scale: 1.0 },
		phraseDensityGpt: { expected: 0.4, scale: 0.6 },
		phraseDensityClaude: { expected: 0.4, scale: 0.6 },
		phraseDensityGemini: { expected: 3.0, scale: 1.8 },
		reasoningTicDensity: { expected: 1.8, scale: 1.2 },
		selfCorrectionDensity: { expected: 0.7, scale: 0.8 },
		stepEnumerationDensity: { expected: 1.2, scale: 1.0 },
		multiToolBatch: { expected: 0.4, scale: 0.5 },
	}),
	kimi: profile("kimi", {
		emDashDensity: { expected: 0.4, scale: 0.8 },
		exclaimOpener: { expected: 0.1, scale: 0.3 },
		boldHeaderDensity: { expected: 0.5, scale: 0.6 },
		mdHeaderDensity: { expected: 0.6, scale: 0.8 },
		bulletDensity: { expected: 1.0, scale: 1.0 },
		emojiDensity: { expected: 0.1, scale: 0.3 },
		phraseDensityGpt: { expected: 0.3, scale: 0.6 },
		phraseDensityClaude: { expected: 0.6, scale: 0.8 },
		phraseDensityGemini: { expected: 0.3, scale: 0.6 },
		reasoningTicDensity: { expected: 3.0, scale: 2.0 },
		selfCorrectionDensity: { expected: 1.2, scale: 1.0 },
		stepEnumerationDensity: { expected: 2.0, scale: 1.5 },
		multiToolBatch: { expected: 0.4, scale: 0.5 },
	}),
	deepseek: profile("deepseek", {
		emDashDensity: { expected: 0.4, scale: 0.8 },
		exclaimOpener: { expected: 0.1, scale: 0.3 },
		boldHeaderDensity: { expected: 0.5, scale: 0.6 },
		mdHeaderDensity: { expected: 0.6, scale: 0.8 },
		bulletDensity: { expected: 1.0, scale: 1.0 },
		emojiDensity: { expected: 0.1, scale: 0.3 },
		phraseDensityGpt: { expected: 0.3, scale: 0.6 },
		phraseDensityClaude: { expected: 0.5, scale: 0.8 },
		phraseDensityGemini: { expected: 0.3, scale: 0.6 },
		reasoningTicDensity: { expected: 4.0, scale: 2.0 }, // R1-style heavy traces
		selfCorrectionDensity: { expected: 1.5, scale: 1.2 },
		stepEnumerationDensity: { expected: 2.5, scale: 1.5 },
		multiToolBatch: { expected: 0.4, scale: 0.5 },
	}),
};

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Minimum visible-text length to weight style features (avoid noisy short turns). */
export const MIN_TEXT_CHARS = 120;
/** Minimum reasoning-summary length to weight reasoning features. */
export const MIN_REASONING_CHARS = 160;
/** Cap on a single feature's normalized deviation, so one outlier can't dominate. */
const Z_CAP = 3;
/** Weighted-z margin (distance(expected) - distance(predicted)) required to
 *  escalate from an informational diagnostic to a user-facing warning. */
export const WARN_MARGIN = 3.0;

// ---------------------------------------------------------------------------
// Family resolution
// ---------------------------------------------------------------------------

/** Map a requested model id to its expected family, or undefined to skip. */
export function familyForModelId(modelId: string): ModelFamily | undefined {
	const id = modelId.trim();
	if (/claude/i.test(id)) return "claude";
	if (/\bo[1-9]\d?\b/i.test(id) || /^o[1-9]/i.test(id) || /gpt/i.test(id)) return "gpt";
	if (/gemini/i.test(id)) return "gemini";
	if (/kimi/i.test(id)) return "kimi";
	if (/deepseek|deep-?seek|r1\b/i.test(id)) return "deepseek";
	return undefined;
}

// ---------------------------------------------------------------------------
// Feature extraction (pure)
// ---------------------------------------------------------------------------

export interface FingerprintBlock {
	type: "text" | "thinking" | "toolCall";
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}
export interface FingerprintInput {
	content: ReadonlyArray<FingerprintBlock>;
	responseModel?: string;
}
export type FeatureVector = Record<FeatureName, number>;

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let from = 0;
	while ((from = haystack.indexOf(needle, from)) !== -1) {
		count++;
		from += needle.length;
	}
	return count;
}

function perThousand(count: number, chars: number): number {
	return chars > 0 ? (count / chars) * 1000 : 0;
}

function phraseDensity(text: string, lower: string, phrases: string[]): number {
	let count = 0;
	for (const phrase of phrases) count += countOccurrences(lower, phrase);
	return perThousand(count, text.length);
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/** Extract the full feature vector from an assistant message's content. */
export function extractFeatures(input: FingerprintInput): {
	features: FeatureVector;
	textBody: string;
	reasoningBody: string;
	toolCallCount: number;
} {
	let textBody = "";
	let reasoningBody = "";
	let toolCallCount = 0;
	for (const block of input.content as FingerprintBlock[]) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") textBody += block.text;
		else if (block.type === "thinking" && typeof block.thinking === "string") reasoningBody += block.thinking;
		else if (block.type === "toolCall") toolCallCount++;
	}

	const textLower = textBody.toLowerCase();
	const textChars = textBody.length;
	const f = emptyFeatures();
	f.emDashDensity = perThousand(countOccurrences(textBody, "\u2014"), textChars);
	f.exclaimOpener = /^\s*(certainly|sure|of course|absolutely|great question|happy to help|i'?d be (happy|glad) to)[!.]/i.test(
		textBody.slice(0, 240),
	)
		? 1
		: 0;
	f.boldHeaderDensity = perThousand(countLines(textBody, /^\s*\*\*[^\n*]+\*\*\s*$/), textChars);
	f.mdHeaderDensity = perThousand(countLines(textBody, /^\s*#{1,6}\s/), textChars);
	f.bulletDensity = perThousand(countLines(textBody, /^\s*[-*•]\s/), textChars);
	f.emojiDensity = perThousand((textBody.match(EMOJI_RE) ?? []).length, textChars);
	f.phraseDensityGpt = phraseDensity(textBody, textLower, PHRASES.gpt);
	f.phraseDensityClaude = phraseDensity(textBody, textLower, PHRASES.claude);
	f.phraseDensityGemini = phraseDensity(textBody, textLower, PHRASES.gemini);

	const reasonLower = reasoningBody.toLowerCase();
	const reasonChars = reasoningBody.length;
	f.reasoningTicDensity = phraseDensity(
		reasoningBody,
		reasonLower,
		["wait", "let me", "let's", "so,", "first", "next", "then", "therefore", "step", "actually"],
	);
	f.selfCorrectionDensity = phraseDensity(
		reasoningBody,
		reasonLower,
		["wait,", "actually,", "let me reconsider", "no, that", "i was wrong", "hmm", "i need to reconsider", "let me correct", "that's not right"],
	);
	f.stepEnumerationDensity =
		perThousand((reasoningBody.match(/\b\d+\.\s/g) ?? []).length, reasonChars) +
		phraseDensity(reasoningBody, reasonLower, ["first", "second", "third", "fourth", "fifth", "finally", "lastly"]);

	f.multiToolBatch = toolCallCount > 1 ? 1 : 0;
	return { features: f, textBody, reasoningBody, toolCallCount };
}

function emptyFeatures(): FeatureVector {
	const f = {} as FeatureVector;
	for (const name of ALL_FEATURES) f[name] = 0;
	return f;
}

/** Build a feature vector, useful for tests or for callers injecting synthetic
 *  fingerprints. Unspecified features default to zero. */
export function createFeatureVector(overrides?: Partial<FeatureVector>): FeatureVector {
	return { ...emptyFeatures(), ...(overrides ?? {}) };
}

function countLines(text: string, re: RegExp): number {
	let count = 0;
	for (const line of text.split("\n")) if (re.test(line)) count++;
	return count;
}

// ---------------------------------------------------------------------------
// Matching (pure)
// ---------------------------------------------------------------------------

export interface FingerprintMatch {
	expected: ModelFamily;
	predicted: ModelFamily;
	distanceExpected: number;
	distancePredicted: number;
	margin: number; // distanceExpected - distancePredicted (positive favors a swap)
	confidence: number; // 0..1, how strongly the response favors `predicted`
	flags: string[]; // human-readable features that voted for `predicted`
}

function effectiveWeights(hasText: boolean, hasReasoning: boolean): Partial<Record<FeatureName, number>> {
	const w: Partial<Record<FeatureName, number>> = { ...FEATURE_WEIGHTS };
	if (!hasText) for (const name of STYLE_FEATURES) w[name] = 0;
	if (!hasReasoning) for (const name of REASONING_FEATURES) w[name] = 0;
	return w;
}

/** Compute a family's weighted distance and per-feature contributions. */
function scoreFamily(
	features: FeatureVector,
	profile: FamilyProfile,
	weights: Partial<Record<FeatureName, number>>,
): { distance: number; perFeature: Record<FeatureName, number> } {
	let distance = 0;
	const perFeature = emptyFeatures();
	for (const name of ALL_FEATURES) {
		const weight = weights[name] ?? 0;
		if (!weight) continue;
		const spec = profile.features[name];
		if (!spec || spec.scale <= 0) continue;
		const z = Math.min(Math.abs(features[name] - spec.expected) / spec.scale, Z_CAP);
		const contribution = weight * z;
		distance += contribution;
		perFeature[name] = contribution;
	}
	return { distance, perFeature };
}

export function matchFingerprint(
	features: FeatureVector,
	expected: ModelFamily,
	options?: {
		profiles?: Record<ModelFamily, FamilyProfile>;
		hasText?: boolean;
		hasReasoning?: boolean;
		/** Per-feature weight overrides, merged onto the effective weights
		 *  (a 0 disables a feature without zeroing the others). */
		weights?: Partial<Record<FeatureName, number>>;
		maxFlags?: number;
	},
): FingerprintMatch {
	const profiles = options?.profiles ?? DEFAULT_PROFILES;
	const weights = { ...effectiveWeights(options?.hasText ?? true, options?.hasReasoning ?? true), ...(options?.weights ?? {}) };
	const maxFlags = options?.maxFlags ?? 3;

	const scored = (Object.keys(profiles) as ModelFamily[]).map((family) => ({
		family,
		...scoreFamily(features, profiles[family], weights),
	}));

	let predicted = scored[0];
	for (const candidate of scored) if (candidate.distance < predicted.distance) predicted = candidate;

	const distanceExpected = scored.find((s) => s.family === expected)?.distance ?? predicted.distance;
	const distancePredicted = predicted.distance;
	const margin = distanceExpected - distancePredicted;
	const total = distanceExpected + distancePredicted;
	const confidence = total > 0 ? Math.max(0, margin / total) : 0;

	// Flags: features where the response fits `predicted` better than `expected`,
	// ranked by how much they favor the swap. These are what a human verifies.
	const expectedProfile = profiles[expected];
	const flags = scored.length && expectedProfile
		? (Object.keys(predicted.perFeature) as FeatureName[])
				.map((name) => ({
					name,
					gap: (expectedProfile.features[name] ? perFeatureZ(features[name], expectedProfile.features[name]) : 0) -
						predicted.perFeature[name] / (weights[name] ?? 1),
					measured: features[name],
				}))
				.filter((entry) => entry.gap > 0.5)
				.sort((a, b) => b.gap - a.gap)
				.slice(0, maxFlags)
				.map((entry) => `${FEATURE_LABELS[entry.name]}: ${formatValue(entry.name, entry.measured)}`)
		: [];

	return { expected, predicted: predicted.family, distanceExpected, distancePredicted, margin, confidence, flags };
}

function perFeatureZ(measured: number, spec: FeatureSpec): number {
	return Math.min(Math.abs(measured - spec.expected) / spec.scale, Z_CAP);
}

function formatValue(name: FeatureName, value: number): string {
	return name === "exclaimOpener" || name === "multiToolBatch"
		? value ? "present" : "absent"
		: value.toFixed(1);
}

// ---------------------------------------------------------------------------
// Per-response analysis + diagnostic
// ---------------------------------------------------------------------------

export interface ResponseFingerprint {
	match: FingerprintMatch;
	diagnostic: AssistantMessageDiagnostic;
	/** Non-empty only when the mismatch clears WARN_MARGIN; surfaces via ui.notify. */
	warning?: string;
	/** Dedupe key for the warning (expected|predicted), to avoid alert spam. */
	warningKey?: string;
}

/** Analyze one assistant response against the family expected for `modelId`.
 *  Returns undefined when there is nothing to fingerprint (unknown family, or
 *  too little text and reasoning to weight any feature). */
export function analyzeResponse(
	message: FingerprintInput & { model?: string },
	modelId: string,
	options?: { profiles?: Record<ModelFamily, FamilyProfile> },
): ResponseFingerprint | undefined {
	const expected = familyForModelId(modelId);
	if (!expected) return undefined;

	const { features, textBody, reasoningBody, toolCallCount } = extractFeatures(message);
	const hasText = textBody.length >= MIN_TEXT_CHARS;
	const hasReasoning = reasoningBody.length >= MIN_REASONING_CHARS;
	if (!hasText && !hasReasoning) return undefined; // nothing reliable to weigh

	const match = matchFingerprint(features, expected, {
		profiles: options?.profiles,
		hasText,
		hasReasoning,
	});

	const confidencePct = Math.round(match.confidence * 100);
	const diagnostic: AssistantMessageDiagnostic = {
		type: "model_fingerprint",
		timestamp: Date.now(),
		details: {
			expectedFamily: expected,
			predictedFamily: match.predicted,
			declaredModel: message.responseModel,
			confidence: confidencePct,
			margin: Number(match.margin.toFixed(2)),
			textChars: textBody.length,
			reasoningChars: reasoningBody.length,
			toolCalls: toolCallCount,
			flags: match.flags,
		},
	};

	let warning: string | undefined;
	let warningKey: string | undefined;
	if (match.predicted !== expected && match.margin >= WARN_MARGIN) {
		warningKey = `${expected}|${match.predicted}`;
		const flagText = match.flags.length ? ` Notably: ${match.flags.join("; ")}.` : "";
		warning =
			`Gateway "${modelId}" responded like a ${match.predicted} model, not ${expected} ` +
			`(fingerprint mismatch, ~${confidencePct}% confidence).${flagText}`;
	}

	return { match, diagnostic, warning, warningKey };
}

// ---------------------------------------------------------------------------
// Session scope (ui delivery), mirrors thinking-compression / preferred-providers
// ---------------------------------------------------------------------------

type Mode = "tui" | "rpc" | "json" | "print";
type FpScope = { mode: Mode; ui: ExtensionUIContext };
type FpState = { sessions: Map<string, FpScope>; last?: string; reported: Set<string> };
const SCOPE_KEY = Symbol.for("pi-surplus-intelligence:fingerprint");

function state(): FpState {
	const host = globalThis as Record<PropertyKey, unknown>;
	const existing = host[SCOPE_KEY] as FpState | undefined;
	if (existing) return existing;
	const fresh: FpState = { sessions: new Map(), reported: new Set() };
	host[SCOPE_KEY] = fresh;
	return fresh;
}

export function configureFingerprint(input: {
	sessionId: string;
	mode: Mode;
	ui: ExtensionUIContext;
}): void {
	const current = state();
	current.sessions.set(input.sessionId, { mode: input.mode, ui: input.ui });
	current.last = input.sessionId;
}

export function releaseFingerprint(sessionId: string): void {
	const current = state();
	current.sessions.delete(sessionId);
	if (current.last === sessionId) current.last = current.sessions.keys().next().value;
}

function scopeFor(sessionId?: string): FpScope | undefined {
	const current = state();
	if (sessionId) {
		const scope = current.sessions.get(sessionId);
		if (scope) return scope;
	}
	return current.last ? current.sessions.get(current.last) : undefined;
}

/** Deliver a fingerprint warning through the foreground TUI, deduped per
 *  (expected,predicted) pair so a persistent swap doesn't spam every turn. */
export function notifyFingerprintWarning(sessionId: string | undefined, key: string, text: string): void {
	const scope = scopeFor(sessionId);
	if (!scope) return;
	const current = state();
	if (current.reported.has(key)) return;
	current.reported.add(key);
	const helper = (globalThis as Record<symbol, unknown>)[Symbol.for("gkqa-flag-sink:with-notification-metadata")];
	if (typeof helper === "function") {
		(helper as (meta: { source: string; category: string; detail: { dedupeKey: string } }, callback: () => void) => void)(
			{ source: "pi-surplus-intelligence", category: "model-fingerprint", detail: { dedupeKey: key } },
			() => scope.ui.notify(text, "warning"),
		);
		return;
	}
	scope.ui.notify(text, "warning");
}

// Re-export a typed ProviderId for callers that build messages, to avoid an
// extra import site.
export type { ProviderId };