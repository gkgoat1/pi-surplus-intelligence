import assert from "node:assert/strict";
import { test } from "node:test";
import { INFERHUB, SURPLUS_INTELLIGENCE } from "../src/constants.ts";
import { fallbackModels, mapGatewayModel, usesOpenAIResponsesApi } from "../src/models.ts";

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

test("fallback models are well-formed per provider", () => {
	for (const descriptor of [SURPLUS_INTELLIGENCE, INFERHUB]) {
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