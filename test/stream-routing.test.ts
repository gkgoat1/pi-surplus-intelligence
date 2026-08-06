import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { configurePreferredProviders } from "../src/preferred-providers.ts";
import { createSurplusStreamSimple } from "../src/stream.ts";

class RecordingStream implements AsyncIterable<any> {
	readonly events: any[] = [];
	readonly finished: Promise<void>;
	private resolveFinished!: () => void;

	constructor() {
		this.finished = new Promise((resolve) => {
			this.resolveFinished = resolve;
		});
	}

	push(event: any): void {
		this.events.push(event);
	}

	end(): void {
		this.resolveFinished();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<any> {
		// Source streams are supplied as async generators in these tests.
	}
}

function model(id: string): Model<any> {
	return {
		id,
		name: id,
		provider: "surplus-intelligence",
		api: "surplus-openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function completedMessage(selectedModel: Model<any>, text: string): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: selectedModel.api,
		provider: selectedModel.provider,
		model: selectedModel.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolCallMessage(selectedModel: Model<any>, toolCall: { id: string; name: string; arguments: any }): any {
	return {
		role: "assistant",
		content: [{ type: "toolCall", ...toolCall }],
		api: selectedModel.api,
		provider: selectedModel.provider,
		model: selectedModel.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function configureEmptyPreferredRoutes(sessionId: string): void {
	configurePreferredProviders({
		sessionId,
		cwd: process.cwd(),
		modelRegistry: {} as any,
		mode: "print",
		ui: { setStatus() {} } as any,
		trusted: false,
	});
}

function helpersWith(overrides: {
	completionsStream?: (model: any, context: any, options: any) => AsyncIterable<any>;
	responsesToolStream?: (model: any, context: any, options: any) => AsyncIterable<any>;
}) {
	let sink: RecordingStream | undefined;
	const calls: Array<{ api: string; options: any }> = [];
	const completionsStream = overrides.completionsStream ?? (() => { throw new Error("completionsStream not expected"); });
	const responsesToolStream = overrides.responsesToolStream ?? (() => { throw new Error("responsesToolStream not expected"); });
	return {
		streamSimple: createSurplusStreamSimple({
			completionsStream: (_model: any, _context: any, options: any) => {
				calls.push({ api: "completions", options });
				return completionsStream(_model, _context, options) as any;
			},
			responsesToolStream: (_model: any, _context: any, options: any) => {
				calls.push({ api: "responses-tools", options });
				return responsesToolStream(_model, _context, options) as any;
			},
			createAssistantMessageEventStream() {
				sink = new RecordingStream();
				return sink;
			},
		} as any),
		get sink() {
			if (!sink) throw new Error("createAssistantMessageEventStream was not called");
			return sink;
		},
		calls,
	};
}

test("routes GPT-5 through the direct Responses fallback and preserves the completed answer", async () => {
	const selectedModel = model("gpt-5.6-luna-pro");
	const answer = completedMessage(selectedModel, "Responses API answer");
	const source = (async function* () {
		yield { type: "start", partial: answer };
		yield { type: "text_delta", contentIndex: 0, delta: answer.content[0].text, partial: answer };
		yield { type: "done", reason: "stop", message: answer };
	})();
	const helper = helpersWith({
		responsesToolStream: () => source,
	});
	configureEmptyPreferredRoutes("gpt-5-responses-routing");

	helper.streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "gpt-5-responses-routing",
		reasoning: "medium",
	});
	await helper.sink.finished;

	assert.deepEqual(helper.calls.map((call) => call.api), ["responses-tools"]);
	assert.equal(helper.calls[0].options.reasoningEffort, "medium");
	assert.equal(helper.calls[0].options.reasoningSummary, "auto");
	assert.equal(helper.sink.events.at(-1).type, "done");
	assert.equal(helper.sink.events.at(-1).message.content[0].text, "Responses API answer");
});

test("routes GPT-5 with tools through the direct Responses tool fallback", async () => {
	const selectedModel = model("gpt-5.6-terra");
	const toolCall = toolCallMessage(selectedModel, {
		id: "call_test|fc_call_test",
		name: "bash",
		arguments: { command: "true" },
	});
	const source = (async function* () {
		yield { type: "start", partial: toolCall };
		yield { type: "toolcall_start", contentIndex: 0, partial: toolCall };
		yield { type: "toolcall_end", contentIndex: 0, toolCall: toolCall.content[0], partial: toolCall };
		yield { type: "done", reason: "toolUse", message: toolCall };
	})();
	const helper = helpersWith({
		responsesToolStream: () => source,
	});
	configureEmptyPreferredRoutes("gpt-5-responses-tool-routing");

	helper.streamSimple(selectedModel, {
		messages: [],
		tools: [{ name: "bash", description: "Run shell", parameters: { type: "object" } as any }],
	} as any, {
		sessionId: "gpt-5-responses-tool-routing",
		reasoning: "medium",
	});
	await helper.sink.finished;

	assert.deepEqual(helper.calls.map((call) => call.api), ["responses-tools"]);
	assert.equal(helper.calls[0].options.reasoningEffort, "medium");
	assert.equal(helper.calls[0].options.reasoningSummary, "auto");
	assert.equal(helper.sink.events.at(-1).type, "done");
	assert.equal(helper.sink.events.at(-1).message.content[0].type, "toolCall");
	assert.equal(helper.sink.events.at(-1).message.content[0].name, "bash");
});

test("retries a pre-output provider error without exposing the failed attempt", async () => {
	const selectedModel = model("gpt-5.6-terra");
	let responsesCalls = 0;
	const answer = completedMessage(selectedModel, "Retry succeeded");
	const failed = completedMessage(selectedModel, "");
	failed.stopReason = "error";
	failed.errorMessage = "Provider returned 400: upstream rejected the request";
	const helper = helpersWith({
		responsesToolStream: () => {
			responsesCalls++;
			return (async function* () {
				if (responsesCalls === 1) {
					yield { type: "start", partial: failed };
					yield { type: "error", reason: "error", error: failed };
					return;
				}
				yield { type: "start", partial: answer };
				yield { type: "text_delta", contentIndex: 0, delta: answer.content[0].text, partial: answer };
				yield { type: "done", reason: "stop", message: answer };
			})() as any;
		},
	});
	configureEmptyPreferredRoutes("retry-provider-errors");

	helper.streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "retry-provider-errors",
	});
	await helper.sink.finished;

	assert.equal(responsesCalls, 2);
	assert.equal(helper.sink.events.filter((event) => event.type === "error").length, 0);
	assert.equal(helper.sink.events.filter((event) => event.type === "start").length, 1);
	assert.equal(helper.sink.events.at(-1).message.content[0].text, "Retry succeeded");
});

test("does not retry a provider error after output has started", async () => {
	const selectedModel = model("gpt-5.6-terra");
	let responsesCalls = 0;
	const failed = completedMessage(selectedModel, "");
	failed.stopReason = "error";
	failed.errorMessage = "Provider returned 400: upstream rejected the request";
	const helper = helpersWith({
		responsesToolStream: () => {
			responsesCalls++;
			return (async function* () {
				yield { type: "start", partial: failed };
				yield { type: "text_delta", contentIndex: 0, delta: "partial", partial: failed };
				yield { type: "error", reason: "error", error: failed };
			})() as any;
		},
	});
	configureEmptyPreferredRoutes("do-not-retry-partial-output");

	helper.streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "do-not-retry-partial-output",
	});
	await helper.sink.finished;

	assert.equal(responsesCalls, 1);
	assert.equal(helper.sink.events.at(-1).type, "error");
});

test("retries an empty GPT-5 response without exposing its empty events", async () => {
	const selectedModel = model("gpt-5.6-terra");
	let responsesCalls = 0;
	const empty = completedMessage(selectedModel, "");
	const answer = completedMessage(selectedModel, "Retry succeeded");
	const helper = helpersWith({
		responsesToolStream: () => {
			responsesCalls++;
			return (async function* () {
				const message = responsesCalls === 1 ? empty : answer;
				yield { type: "start", partial: message };
				yield { type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message };
				yield { type: "done", reason: "stop", message };
			})() as any;
		},
	});
	configureEmptyPreferredRoutes("retry-empty-responses");

	helper.streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "retry-empty-responses",
	});
	await helper.sink.finished;

	assert.equal(responsesCalls, 2);
	assert.equal(helper.sink.events.filter((event) => event.type === "start").length, 1);
	assert.equal(helper.sink.events.filter((event) => event.type === "text_delta").length, 1);
	assert.equal(helper.sink.events.at(-1).message.content[0].text, "Retry succeeded");
});

test("returns an error after a second empty response", async () => {
	const selectedModel = model("gpt-5.6-terra");
	let responsesCalls = 0;
	const empty = completedMessage(selectedModel, "");
	const helper = helpersWith({
		responsesToolStream: () => {
			responsesCalls++;
			return (async function* () {
				yield { type: "start", partial: empty };
				yield { type: "done", reason: "stop", message: empty };
			})() as any;
		},
	});
	configureEmptyPreferredRoutes("retry-empty-exhausted");

	helper.streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "retry-empty-exhausted",
	});
	await helper.sink.finished;

	assert.equal(responsesCalls, 2);
	assert.equal(helper.sink.events.at(-1).type, "error");
	assert.match(helper.sink.events.at(-1).error.errorMessage, /no assistant text or tool calls/);
});

test("keeps pre-GPT-5 streams on chat completions and preserves the completed answer", async () => {
	const selectedModel = model("gpt-4.1");
	const answer = completedMessage(selectedModel, "Chat completions answer");
	const source = (async function* () {
		yield { type: "start", partial: answer };
		yield { type: "done", reason: "stop", message: answer };
	})();
	const helper = helpersWith({
		completionsStream: () => source,
	});
	configureEmptyPreferredRoutes("gpt-4-completions-routing");

	helper.streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "gpt-4-completions-routing",
		reasoning: "low",
	});
	await helper.sink.finished;

	assert.deepEqual(helper.calls.map((call) => call.api), ["completions"]);
	assert.equal(helper.calls[0].options.reasoningEffort, "low");
	assert.equal(helper.sink.events.at(-1).type, "done");
	assert.equal(helper.sink.events.at(-1).message.content[0].text, "Chat completions answer");
});