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

test("routes GPT-5 streams through Responses and preserves the completed answer", async () => {
	const selectedModel = model("gpt-5.6-luna-pro");
	const calls: Array<{ api: string; options: any }> = [];
	let sink: RecordingStream | undefined;
	const answer = completedMessage(selectedModel, "Responses API answer");
	const source = (async function* () {
		yield { type: "start", partial: answer };
		yield { type: "text_delta", contentIndex: 0, delta: answer.content[0].text, partial: answer };
		yield { type: "done", reason: "stop", message: answer };
	})();
	const streamSimple = createSurplusStreamSimple({
		completionsStream(_model: any, _context: any, options: any) {
			calls.push({ api: "completions", options });
			return source as any;
		},
		responsesStream(_model: any, _context: any, options: any) {
			calls.push({ api: "responses", options });
			return source as any;
		},
		createAssistantMessageEventStream() {
			sink = new RecordingStream();
			return sink as any;
		},
	} as any);
	configureEmptyPreferredRoutes("gpt-5-responses-routing");

	streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "gpt-5-responses-routing",
		reasoning: "medium",
	});
	await sink!.finished;

	assert.deepEqual(calls.map((call) => call.api), ["responses"]);
	assert.equal(calls[0].options.reasoningEffort, "medium");
	assert.equal(calls[0].options.reasoningSummary, "auto");
	assert.equal(sink!.events.at(-1).type, "done");
	assert.equal(sink!.events.at(-1).message.content[0].text, "Responses API answer");
});

test("retries an empty GPT-5 response without exposing its empty events", async () => {
	const selectedModel = model("gpt-5.6-terra");
	let responsesCalls = 0;
	let sink: RecordingStream | undefined;
	const empty = completedMessage(selectedModel, "");
	const answer = completedMessage(selectedModel, "Retry succeeded");
	const streamSimple = createSurplusStreamSimple({
		completionsStream() {
			throw new Error("GPT-5 must not use chat completions");
		},
		responsesStream() {
			responsesCalls++;
			return (async function* () {
				const message = responsesCalls === 1 ? empty : answer;
				yield { type: "start", partial: message };
				yield { type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message };
				yield { type: "done", reason: "stop", message };
			})() as any;
		},
		createAssistantMessageEventStream() {
			sink = new RecordingStream();
			return sink as any;
		},
	} as any);
	configureEmptyPreferredRoutes("retry-empty-responses");

	streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "retry-empty-responses",
	});
	await sink!.finished;

	assert.equal(responsesCalls, 2);
	assert.equal(sink!.events.filter((event) => event.type === "start").length, 1);
	assert.equal(sink!.events.filter((event) => event.type === "text_delta").length, 1);
	assert.equal(sink!.events.at(-1).message.content[0].text, "Retry succeeded");
});

test("returns an error after a second empty response", async () => {
	const selectedModel = model("gpt-5.6-terra");
	let responsesCalls = 0;
	let sink: RecordingStream | undefined;
	const empty = completedMessage(selectedModel, "");
	const streamSimple = createSurplusStreamSimple({
		completionsStream() {
			throw new Error("GPT-5 must not use chat completions");
		},
		responsesStream() {
			responsesCalls++;
			return (async function* () {
				yield { type: "start", partial: empty };
				yield { type: "done", reason: "stop", message: empty };
			})() as any;
		},
		createAssistantMessageEventStream() {
			sink = new RecordingStream();
			return sink as any;
		},
	} as any);
	configureEmptyPreferredRoutes("retry-empty-exhausted");

	streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "retry-empty-exhausted",
	});
	await sink!.finished;

	assert.equal(responsesCalls, 2);
	assert.equal(sink!.events.at(-1).type, "error");
	assert.match(sink!.events.at(-1).error.errorMessage, /no assistant text or tool calls/);
});
	test("keeps pre-GPT-5 streams on chat completions and preserves the completed answer", async () => {
	const selectedModel = model("gpt-4.1");
	const calls: Array<{ api: string; options: any }> = [];
	let sink: RecordingStream | undefined;
	const answer = completedMessage(selectedModel, "Chat completions answer");
	const source = (async function* () {
		yield { type: "start", partial: answer };
		yield { type: "done", reason: "stop", message: answer };
	})();
	const streamSimple = createSurplusStreamSimple({
		completionsStream(_model: any, _context: any, options: any) {
			calls.push({ api: "completions", options });
			return source as any;
		},
		responsesStream(_model: any, _context: any, options: any) {
			calls.push({ api: "responses", options });
			return source as any;
		},
		createAssistantMessageEventStream() {
			sink = new RecordingStream();
			return sink as any;
		},
	} as any);
	configureEmptyPreferredRoutes("gpt-4-completions-routing");

	streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "gpt-4-completions-routing",
		reasoning: "low",
	});
	await sink!.finished;

	assert.deepEqual(calls.map((call) => call.api), ["completions"]);
	assert.equal(calls[0].options.reasoningEffort, "low");
	assert.equal(sink!.events.at(-1).type, "done");
	assert.equal(sink!.events.at(-1).message.content[0].text, "Chat completions answer");
});