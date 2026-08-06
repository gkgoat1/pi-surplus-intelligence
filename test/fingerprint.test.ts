import assert from "node:assert/strict";
import { test } from "node:test";
import {
	analyzeResponse,
	createFeatureVector,
	DEFAULT_PROFILES,
	extractFeatures,
	familyForModelId,
	FEATURE_WEIGHTS,
	matchFingerprint,
	MIN_TEXT_CHARS,
	WARN_MARGIN,
	type FeatureVector,
	type FingerprintBlock,
	type ModelFamily,
} from "../src/fingerprint.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistant(content: FingerprintBlock[], responseModel?: string) {
	return { role: "assistant", content, responseModel } as const;
}

/** Build a vector that exactly matches a family's default expected profile. */
function familyVector(family: ModelFamily): FeatureVector {
	return createFeatureVector(
		Object.fromEntries(
			Object.entries(DEFAULT_PROFILES[family].features).map(([name, spec]) => [name, spec.expected]),
		) as Partial<FeatureVector>,
	);
}

// ---------------------------------------------------------------------------

test("familyForModelId resolves known families and rejects unknowns", () => {
	const cases: Array<[string, ModelFamily | undefined]> = [
		["claude-sonnet-5", "claude"],
		["claude-opus-4.1", "claude"],
		["gpt-5.6-luna-pro", "gpt"],
		["gpt-4o", "gpt"],
		["o3-mini", "gpt"],
		["kimi-k2.7-code", "kimi"],
		["deepseek-r1", "deepseek"],
		["deepseek-v3", "deepseek"],
		["gemini-2.5-pro", "gemini"],
		["llama-3.1-70b", undefined],
		["qwen-max", undefined],
	];
	for (const [id, expected] of cases) {
		assert.equal(familyForModelId(id), expected, id);
	}
});

// ---------------------------------------------------------------------------

test("extractFeatures measures deterministic surface signals", () => {
	const { features: emDash } = extractFeatures(assistant([{ type: "text", text: "a".repeat(100) + "\u2014".repeat(3) }])); // 3 em-dashes in 103 chars
	assert.equal(emDash.emDashDensity, (3 / 103) * 1000);

	const { features: opener } = extractFeatures(assistant([{ type: "text", text: "Certainly! Here's the plan." }]));
	assert.equal(opener.exclaimOpener, 1);

	const { features: header } = extractFeatures(assistant([{ type: "text", text: "Intro\n**Section One**\nBody" }]));
	assert.equal(header.boldHeaderDensity, (1 / "Intro\n**Section One**\nBody".length) * 1000);

	const { features: bullets } = extractFeatures(assistant([{ type: "text", text: "- one\n- two\n* three" }]));
	assert.equal(bullets.bulletDensity, (3 / "- one\n- two\n* three".length) * 1000);

	const { features: gptPhrases } = extractFeatures(assistant([{ type: "text", text: "Certainly, of course. Let me know if." }]));
	assert.ok(gptPhrases.phraseDensityGpt > gptPhrases.phraseDensityClaude);
	assert.ok(gptPhrases.phraseDensityGpt > gptPhrases.phraseDensityGemini);
});

// ---------------------------------------------------------------------------
// Matching machinery tests (controlled vectors, no brittle text classification)
// ---------------------------------------------------------------------------

test("matchFingerprint classifies a vector that matches a family's expected profile", () => {
	for (const family of ["claude", "gpt", "gemini", "kimi", "deepseek"] as ModelFamily[]) {
		const match = matchFingerprint(familyVector(family), family, { hasText: true, hasReasoning: false });
		assert.equal(match.predicted, family, `expected ${family} -> predicted ${match.predicted}`);
		assert.ok(match.margin < WARN_MARGIN, "a matching family should not clear the warning margin");
	}
});

test("matchFingerprint warns when the response vector clearly belongs to a different family", () => {
	const match = matchFingerprint(familyVector("claude"), "gpt", { hasText: true, hasReasoning: false });
	assert.equal(match.predicted, "claude");
	assert.ok(match.margin >= WARN_MARGIN, `margin ${match.margin} should clear ${WARN_MARGIN}`);
	assert.ok(match.flags.length > 0, "flags name the discriminating features");
});

test("analyzeResponse warns on a strong cross-family mismatch", () => {
	// A visibly Claude-flavored answer served under a GPT model id.
	const claudeText =
		"Here's how I'd approach this problem—I'll start by clarifying the requirements, then move " +
		"through the implementation step by step. Let me outline the key considerations—a few things " +
		"matter here: correctness, readability, and performance. I'd be happy to dig deeper into any " +
		"part. To summarize, the plan balances clarity with correctness—and I'll keep it concise.";

	const mismatch = analyzeResponse(assistant([{ type: "text", text: claudeText }]), "gpt-5.6-luna-pro");
	assert.ok(mismatch, "should analyze");
	assert.equal(mismatch!.match.predicted, "claude");
	assert.ok(mismatch!.warning, "a cross-family mismatch should produce a warning");
	assert.equal(mismatch!.warningKey, "gpt|claude");
	assert.equal(mismatch!.diagnostic.type, "model_fingerprint");
});

test("analyzeResponse does not warn when the family matches", () => {
	const claudeText =
		"Here's how I'd approach this problem—I'll start by clarifying the requirements, then move " +
		"through the implementation step by step. Let me outline the key considerations—a few things " +
		"matter here: correctness, readability, and performance. I'd be happy to dig deeper into any " +
		"part. To summarize, the plan balances clarity with correctness—and I'll keep it concise.";

	const ok = analyzeResponse(assistant([{ type: "text", text: claudeText }]), "claude-sonnet-5");
	assert.ok(ok, "still attaches an informational diagnostic");
	assert.equal(ok!.match.predicted, "claude");
	assert.equal(ok!.warning, undefined, "no warning when predicted matches expected");
});

// ---------------------------------------------------------------------------

test("returns undefined for unknown families and for too-short text", () => {
	assert.equal(analyzeResponse(assistant([{ type: "text", text: "hello world" }]), "llama-3"), undefined);
	assert.equal(
		analyzeResponse(assistant([{ type: "text", text: "ok".repeat(10) }]), "claude-sonnet-5"),
		undefined,
		`text below ${MIN_TEXT_CHARS} chars with no reasoning should not be fingerprinted`,
	);
});

// ---------------------------------------------------------------------------
// Tunability tests
// ---------------------------------------------------------------------------

test("swapping profiles reclassifies the same response vector", () => {
	const vector = familyVector("claude");
	const baseline = matchFingerprint(vector, "gpt", { hasText: true, hasReasoning: false });
	assert.equal(baseline.predicted, "claude", "default profiles map the Claude vector to claude");

	// Retune: make GPT expect the same values Claude does.
	// Swap the claude and gpt profiles so the Claude-shaped vector is now a
	// better fit for the (retuned) gpt profile than for the (retuned) claude one.
	const retuned: Record<ModelFamily, (typeof DEFAULT_PROFILES)[ModelFamily]> = {
		...DEFAULT_PROFILES,
		claude: { ...DEFAULT_PROFILES.claude, features: DEFAULT_PROFILES.gpt.features },
		gpt: { ...DEFAULT_PROFILES.gpt, features: DEFAULT_PROFILES.claude.features },
	};
	const after = matchFingerprint(vector, "gpt", { profiles: retuned, hasText: true, hasReasoning: false });
	assert.equal(after.predicted, "gpt", "retuning the profiles reclassifies the same vector");
});

test("zeroing weights removes feature influence", () => {
	const vector = familyVector("claude");
	const full = matchFingerprint(vector, "gpt", { hasText: true, hasReasoning: false });
	const zeroed = Object.fromEntries(Object.keys(FEATURE_WEIGHTS).map((k) => [k, 0])) as Partial<FeatureVector>;
	const neutral = matchFingerprint(vector, "gpt", {
		hasText: true,
		hasReasoning: false,
		weights: zeroed,
	});
	assert.notEqual(full.margin, neutral.margin, "zeroing weights changes the margin");
	assert.equal(neutral.margin, 0, "with all weights zero, every family is equally close");
});