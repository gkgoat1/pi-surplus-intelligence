import assert from "node:assert/strict";
import { test } from "node:test";
import { createResponsesToolStream } from "../src/responses-tools.ts";

class RecordingStream {
	events: any[] = [];
	private waiters: Array<() => void> = [];
	private ended = false;
	push(event: any) { this.events.push(event); }
	end() { this.ended = true; for (const resolve of this.waiters.splice(0)) resolve(); }
	wait() { return this.ended ? Promise.resolve() : new Promise<void>((resolve) => this.waiters.push(resolve)); }
}

const model: any = {
	id: "gpt-5.6-terra", name: "GPT 5.6 Terra", provider: "surplus-intelligence",
	api: "surplus-openai-completions", baseUrl: "https://example.test/v1", reasoning: true,
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1,
};

function streamFactory(target: { current?: RecordingStream }) {
	return () => {
		target.current = new RecordingStream();
		return target.current as any;
	};
}

test("surfaces a provider response's nested error message", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify({
		error: { message: "The aggregated upstream rejected this request" },
	}), { status: 400 })) as typeof fetch;

	try {
		const sink: { current?: RecordingStream } = {};
		createResponsesToolStream(streamFactory(sink))(model, { messages: [], tools: [] } as any, { apiKey: "test-key" });
		await sink.current!.wait();

		assert.equal(sink.current!.events.at(-1).type, "error");
		assert.equal(
			sink.current!.events.at(-1).error.errorMessage,
			"Provider returned 400: The aggregated upstream rejected this request",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("recovers a Responses tool call from a completed non-streaming response", async () => {
	const originalFetch = globalThis.fetch;
	const requests: any[] = [];
	globalThis.fetch = (async (url, init) => {
		requests.push({ url, payload: JSON.parse(String(init?.body)) });
		return new Response(JSON.stringify({
			id: "resp_test", status: "completed", usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
			output: [{ type: "function_call", call_id: "call_test", name: "bash", arguments: '{"command":"printf OK"}' }],
		}), { status: 200 });
	}) as typeof fetch;

	try {
		const sink: { current?: RecordingStream } = {};
		createResponsesToolStream(streamFactory(sink))(
			model,
			{
				messages: [{ role: "user", content: "Use bash", timestamp: 0 }],
				tools: [{ name: "bash", description: "Run shell", parameters: { type: "object" } as any }],
			} as any,
			{ apiKey: "test-key", maxTokens: 32 },
		);
		await sink.current!.wait();

		assert.equal(requests.length, 1);
		assert.equal(requests[0].url, "https://example.test/v1/responses");
		assert.equal(requests[0].payload.stream, false);
		assert.equal(requests[0].payload.tools[0].name, "bash");
		assert.equal(sink.current!.events.at(-1).type, "done");
		assert.equal(sink.current!.events.at(-1).reason, "toolUse");
		assert.deepEqual(sink.current!.events.at(-1).message.content, [{
			type: "toolCall", id: "call_test|fc_call_test", name: "bash", arguments: { command: "printf OK" },
		}]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("preserves Pi 0.84 sampling parameters and response hooks", async () => {
	const originalFetch = globalThis.fetch;
	const requests: any[] = [];
	const responses: any[] = [];
	globalThis.fetch = (async (_url, init) => {
		requests.push(JSON.parse(String(init?.body)));
		return new Response(JSON.stringify({
			id: "resp_sampling", status: "completed", usage: {}, output: [],
		}), { status: 200, headers: { "x-request-id": "request-123" } });
	}) as typeof fetch;

	try {
		const sink: { current?: RecordingStream } = {};
		createResponsesToolStream(streamFactory(sink))(
			{ ...model, samplingParams: { temperature: 0.3, top_k: 20 } },
			{ messages: [], tools: [] } as any,
			{
				apiKey: "test-key",
				temperature: 0.9,
				samplingParams: { top_k: 40, min_p: 0.05 },
				onResponse(response) { responses.push(response); },
			},
		);
		await sink.current!.wait();

		assert.deepEqual(
			{ temperature: requests[0].temperature, top_k: requests[0].top_k, min_p: requests[0].min_p },
			{ temperature: 0.3, top_k: 40, min_p: 0.05 },
		);
		assert.equal(responses.length, 1);
		assert.equal(responses[0].status, 200);
		assert.equal(responses[0].headers["x-request-id"], "request-123");
	} finally {
		globalThis.fetch = originalFetch;
	}
});