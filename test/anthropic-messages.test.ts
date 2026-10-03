import assert from "node:assert/strict";
import { test } from "node:test";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";

function anthropicSse(events: Array<{ type: string; [key: string]: unknown }>): Response {
	const body = events
		.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("native Anthropic stream sends Claude thinking/tools and parses tool-use responses", async () => {
	let requestUrl = "";
	let requestHeaders: Headers | undefined;
	let requestBody: Record<string, any> | undefined;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		requestUrl = String(input);
		requestHeaders = new Headers(init?.headers);
		requestBody = JSON.parse(String(init?.body));
		return anthropicSse([
			{
				type: "message_start",
				message: {
					id: "msg_test",
					type: "message",
					role: "assistant",
					model: "claude-opus-4-6",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			},
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_test", name: "lookup", input: {} },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"query":"hello"}' },
			},
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 12 },
			},
			{ type: "message_stop" },
		]);
	}) as typeof fetch;

	try {
		const model = {
			id: "claude-opus-4-6",
			name: "Claude Opus 4.6",
			api: "anthropic-messages",
			provider: "surplus-intelligence-anthropic",
			baseUrl: "https://api.surplusintelligence.ai/anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
		} as any;
		const contextInput = {
			systemPrompt: "Be concise.",
			messages: [{ role: "user", content: "Say hello." }],
			tools: [
				{
					name: "lookup",
					description: "Look up text.",
					parameters: {
						type: "object",
						properties: { query: { type: "string" } },
						required: ["query"],
					},
				},
			],
		};
		const piAi = await import("@earendil-works/pi-ai");
		const context = typeof (piAi as any).normalizeContext === "function"
			? (piAi as any).normalizeContext(contextInput)
			: contextInput;
		const stream = streamSimple(model, context as any, {
			apiKey: "test-key",
			reasoning: "high",
			fetch: globalThis.fetch,
		} as any);
		const events = [];
		for await (const event of stream) events.push(event);

		assert.match(requestUrl, /\/anthropic\/v1\/messages(?:\?|$)/);
		assert.equal(requestHeaders?.get("x-api-key"), "test-key");
		assert.equal(requestHeaders?.get("anthropic-version"), "2023-06-01");
		assert.equal(requestBody?.model, model.id);
		assert.deepEqual(requestBody?.thinking, { type: "adaptive", display: "summarized" });
		assert.deepEqual(requestBody?.output_config, { effort: "high" });
		assert.equal(requestBody?.system?.[0]?.text, "Be concise.");
		assert.equal(requestBody?.tools?.[0]?.name, "lookup");
		const doneEvent = events.at(-1) as any;
		assert.equal(doneEvent?.type, "done");
		assert.equal(doneEvent?.reason, "toolUse");
		assert.deepEqual(doneEvent?.message.content[0], {
			type: "toolCall",
			id: "toolu_test",
			name: "lookup",
			arguments: { query: "hello" },
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});
