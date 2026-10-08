import assert from "node:assert/strict";
import { test } from "node:test";
import { BU0Y, CHEAPER_INFERENCE, INFERHUB, RUVICODE, SURP, SURPLUS_INTELLIGENCE } from "../src/constants.ts";
import { anthropicClaudeModels, clampGatewayThinkingLevel, fallbackModels, mapGatewayModel, usesOpenAIResponsesApi } from "../src/models.ts";

test("uses the Responses API for GPT-5 and later", () => {
	for (const id of ["gpt-5", "gpt-5.6-luna-pro", "GPT-12-preview"]) {
		assert.equal(usesOpenAIResponsesApi(id), true, id);
	}
});

test("keeps pre-GPT-5 and non-GPT models on chat completions", () => {
	for (const id of ["gpt-4.1", "gpt-4o", "kimi-k2.7-code", "my-gpt-5-proxy"]) {
		assert.equal(usesOpenAIResponsesApi(id), false, id);
	}
});

test("InferHub thinkingLevelMap advertises only catalog reasoning_levels, nulling the rest", () => {
	const mapped = mapGatewayModel(
		{
			id: "ag/gemini-3.6-flash-high",
			modality: "text",
			reasoning_levels: ["minimal", "low", "medium", "high"],
			input_token_limit: 1_000_000,
			max_output_tokens: 65_536,
			upstream_label: "Gemini 3.6 Flash",
			pricing: {},
		},
		INFERHUB,
	);
	assert.equal(mapped.reasoning, true);
	assert.equal(mapped.thinkingLevelMap!.minimal, "minimal");
	assert.equal(mapped.thinkingLevelMap!.high, "high");
	assert.equal(mapped.thinkingLevelMap!.max, null);
	assert.equal(mapped.thinkingLevelMap!.off, null);
	assert.equal(mapped.thinkingLevelMap!.xhigh, null);
});

test("clampGatewayThinkingLevel lets unmapped models pass through raw (Surplus compat)", () => {
	assert.equal(clampGatewayThinkingLevel({ reasoning: true }, "max"), "max");
	assert.equal(clampGatewayThinkingLevel({ reasoning: true }, "xhigh"), "xhigh");
	assert.equal(clampGatewayThinkingLevel({}, "low"), "low");
});

test("clamps to the nearest advertised InferHub level, upward first", () => {
	const model = {
		reasoning: true,
		thinkingLevelMap: {
			off: null as null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			max: "max",
			xhigh: null as null,
		},
	};
	assert.equal(clampGatewayThinkingLevel(model, "max"), "max");
	assert.equal(clampGatewayThinkingLevel(model, "medium"), "medium");
	assert.equal(clampGatewayThinkingLevel(model, "xhigh"), "max"); // nearest up
	assert.equal(clampGatewayThinkingLevel(model, "off"), "minimal"); // off unsupported, round up

	const partial = {
		reasoning: true,
		thinkingLevelMap: {
			off: null as null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			max: null as null,
			xhigh: null as null,
		},
	};
	assert.equal(clampGatewayThinkingLevel(partial, "max"), "high");
	assert.equal(clampGatewayThinkingLevel(partial, "xhigh"), "high");
});

test("maps Surplus catalog entries onto the provider's API", () => {
	const mapped = mapGatewayModel(
		{
			id: "kimi-k2.7-code",
			name: "Kimi K2.7 Code",
			architecture: { input_modalities: ["text", "image"] },
			supported_parameters: ["reasoning", "reasoning_effort"],
			context_length: 262_144,
			top_provider: { max_completion_tokens: 65_536 },
			pricing: { prompt: "0.6", completion: "2.5", input_cache_read: "0.1" },
		},
		SURPLUS_INTELLIGENCE,
	);
	assert.equal(mapped.id, "kimi-k2.7-code");
	assert.equal(mapped.api, SURPLUS_INTELLIGENCE.api);
	assert.equal(mapped.name, "Kimi K2.7 Code");
	assert.equal(mapped.reasoning, true);
	assert.deepEqual(mapped.input, ["text", "image"]);
	assert.equal(mapped.cost.input, 600_000);
	assert.equal(mapped.cost.output, 2_500_000);
	assert.equal(mapped.cost.cacheRead, 100_000);
	assert.equal(mapped.contextWindow, 262_144);
	assert.equal(mapped.maxTokens, 65_536);
	assert.equal(mapped.compat.supportsReasoningEffort, true);
});

test("maps InferHub catalog entries with their own envelope", () => {
	const mapped = mapGatewayModel(
		{
			id: "ag/gemini-3.7-flash-high",
			modality: "text,image",
			reasoning_levels: ["minimal", "low", "medium", "high"],
			input_token_limit: 1_000_000,
			max_output_tokens: 65_536,
			upstream_label: "Gemini 3.7 Flash",
			pricing: { min_ask_in: 0.0105, min_ask_out: 0.0525 },
		},
		INFERHUB,
	);
	assert.equal(mapped.id, "ag/gemini-3.7-flash-high");
	assert.equal(mapped.api, INFERHUB.api);
	assert.equal(mapped.name, "Gemini 3.7 Flash");
	assert.equal(mapped.reasoning, true);
	assert.deepEqual(mapped.input, ["text", "image"]);
	assert.equal(mapped.cost.input, 10_500);
	assert.equal(mapped.cost.output, 52_500);
	assert.equal(mapped.contextWindow, 1_000_000);
	assert.equal(mapped.maxTokens, 65_536);
	assert.equal(mapped.compat.supportsReasoningEffort, true);
});

test("maps InferHub entries without reasoning levels or modality defaults", () => {
	const mapped = mapGatewayModel(
		{ id: "ag/claude-sonnet-4-6", modality: null, pricing: { official_in: 3, official_out: 15 } },
		INFERHUB,
	);
	assert.equal(mapped.reasoning, false);
	assert.deepEqual(mapped.input, ["text"]);
	assert.equal(mapped.cost.input, 0);
	assert.equal(mapped.contextWindow, 128_000);
	assert.equal(mapped.compat.supportsReasoningEffort, false);
});

test("maps Cheaper Inference catalog entries and skips non-chat models", () => {
	const mapped = mapGatewayModel(
		{
			id: "claude-opus-4.6",
			type: "text",
			context_length: 1_000_000,
			max_output_tokens: 64_000,
			capabilities: { vision: true, reasoning: true },
			pricing: {
				input_per_million: "3.5",
				output_per_million: "17.5",
				cache_read_input_per_million: "0.35",
			},
		},
		CHEAPER_INFERENCE,
	);
	assert.equal(mapped.id, "claude-opus-4.6");
	assert.equal(mapped.api, CHEAPER_INFERENCE.api);
	assert.equal(mapped.name, "claude-opus-4.6");
	assert.equal(mapped.reasoning, true);
	assert.deepEqual(mapped.input, ["text", "image"]);
	assert.equal(mapped.cost.input, 3.5);
	assert.equal(mapped.cost.output, 17.5);
	assert.equal(mapped.cost.cacheRead, 0.35);
	assert.equal(mapped.contextWindow, 1_000_000);
	assert.equal(mapped.maxTokens, 64_000);
	assert.equal(mapped.compat.supportsReasoningEffort, true);
	assert.equal(mapGatewayModel({ id: "image-model", type: "image" }, CHEAPER_INFERENCE), undefined);
});

test("Anthropic variants use native Messages metadata for Claude only", () => {
	const source = [
		{ id: "ag/claude-opus-4-6", name: "Claude Opus", api: INFERHUB.api, reasoning: true, compat: { supportsReasoningEffort: true } },
		{ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", api: CHEAPER_INFERENCE.api, reasoning: true },
		{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna", api: CHEAPER_INFERENCE.api, reasoning: true },
	];
	const variants = anthropicClaudeModels(source);
	assert.equal(variants.length, 2);
	assert.equal(variants[0].api, "anthropic-messages");
	assert.equal(variants[0].compat.forceAdaptiveThinking, true);
	assert.equal(variants[0].compat.supportsStrictTools, true);
	assert.equal(variants[1].compat.forceAdaptiveThinking, undefined);
	assert.equal(variants[1].compat.supportsStrictTools, true);
	assert.equal(source[0].api, INFERHUB.api, "OpenAI variant remains unchanged");
	assert.equal((source[0].compat as any).forceAdaptiveThinking, undefined);
});

test("fallback models are well-formed per provider", () => {
	for (const descriptor of [SURPLUS_INTELLIGENCE, INFERHUB, CHEAPER_INFERENCE]) {
		const models = fallbackModels(descriptor);
		assert.ok(models.length > 0, descriptor.id);
		for (const model of models) {
			assert.equal(typeof model.id, "string");
			assert.equal(model.api, descriptor.api);
			assert.equal(typeof model.reasoning, "boolean");
			assert.ok(model.input.includes("text"));
			assert.ok(model.contextWindow > 0);
			assert.ok(model.maxTokens > 0);
		}
	}
	// InferHub ids must stay vendor-prefixed; bare ids are rejected upstream.
	assert.ok(fallbackModels(INFERHUB).every((model) => model.id.includes("/")));
});
// --- Phase 2: Surp, Bu0y, Ruvicode ---

test("Surp fallback models are the seven documented routes", () => {
	const ids = fallbackModels(SURP).map((m: any) => m.id);
	assert.deepEqual(ids, [
		"surp/free",
		"surp/value",
		"surp/jev",
		"surp/frontier",
		"surp/fast",
		"surp/vision",
		"surp/custom",
	]);
	assert.ok(fallbackModels(SURP).every((m: any) => m.api === SURP.api));
});

test("maps a Surp combo catalog entry", () => {
	const mapped = mapGatewayModel(
		{
			combo: "surp/best-coding",
			resolved_model: "qwen3-coder-30b-a3b-instruct",
			usd_per_1m_tokens: 0.003465,
			pool_size: 7,
			sellers: 17,
		},
		SURP,
	);
	assert.equal(mapped.id, "surp/best-coding");
	assert.equal(mapped.api, SURP.api);
	assert.ok(typeof mapped.name === "string" && mapped.name.length > 0);
});

test("skips a Surp catalog entry without a combo id", () => {
	assert.equal(mapGatewayModel({ resolved_model: "x" }, SURP), undefined);
});

test("maps a Bu0y catalog entry with per-1M pricing", () => {
	const mapped = mapGatewayModel(
		{
			id: "glm4.6",
			context_length: 131072,
			top_provider: { max_completion_tokens: 32768 },
			inputPer1m: 1_500_000,
			outputPer1m: 6_000_000,
		},
		BU0Y,
	);
	assert.equal(mapped.id, "glm4.6");
	assert.equal(mapped.api, BU0Y.api);
	assert.equal(mapped.cost.input, 1_500_000);
	assert.equal(mapped.cost.output, 6_000_000);
	assert.equal(mapped.contextWindow, 131072);
	assert.equal(mapped.maxTokens, 32768);
});

test("Bu0y fallback models are non-empty and use Bu0y slugs", () => {
	const models = fallbackModels(BU0Y);
	assert.ok(models.length > 0);
	assert.ok(models.every((m: any) => m.api === BU0Y.api && !m.id.includes("/")));
});

test("maps a Ruvicode catalog entry with cache_read_price", () => {
	const mapped = mapGatewayModel(
		{
			id: "claude-fable-5",
			name: "Claude Fable 5",
			context_length: 1_000_000,
			max_completion_tokens: 128_000,
			cache_read_price: 0.39347,
		},
		RUVICODE,
	);
	assert.equal(mapped.id, "claude-fable-5");
	assert.equal(mapped.api, RUVICODE.api);
	assert.equal(mapped.contextWindow, 1_000_000);
	assert.equal(mapped.maxTokens, 128_000);
	assert.ok(mapped.cost.cacheRead > 0);
});

test("maps a Ruvicode entry missing optional pricing fields with zeroed costs", () => {
	const mapped = mapGatewayModel({ id: "some-model" }, RUVICODE);
	assert.equal(mapped.id, "some-model");
	assert.equal(mapped.cost.input, 0);
	assert.equal(mapped.cost.cacheRead, 0);
});

test("Ruvicode fallback models are non-empty", () => {
	assert.ok(fallbackModels(RUVICODE).length > 0);
});
