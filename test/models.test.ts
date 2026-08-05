import assert from "node:assert/strict";
import { test } from "node:test";
import { usesOpenAIResponsesApi } from "../src/models.ts";

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