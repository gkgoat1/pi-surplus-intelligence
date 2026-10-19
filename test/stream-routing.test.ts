import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { configurePreferredProviders } from "../src/preferred-providers.ts";
import { PROVIDERS } from "../src/constants.ts";
import { anthropicClaudeModels, mapGatewayModel } from "../src/models.ts";
import { createGatewayStreamSimple, maxAttemptsForModel, optionsForUpstream, stripAuthorizationFetch, KEYLESS_SENTINEL } from "../src/stream.ts";

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

function model(id: string, provider = "surplus-intelligence"): Model<any> {
	return {
		id,
		name: id,
		provider,
		api: provider === "inferhub" ? "inferhub-openai-completions" : "surplus-openai-completions",
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
	const calls: Array<{ api: string; options: any; baseUrl?: string }> = [];
	const completionsStream = overrides.completionsStream ?? (() => { throw new Error("completionsStream not expected"); });
	const responsesToolStream = overrides.responsesToolStream ?? (() => { throw new Error("responsesToolStream not expected"); });
	return {
		streamSimple: createGatewayStreamSimple({
			completionsStream: (_model: any, _context: any, options: any) => {
				calls.push({ api: "completions", options, baseUrl: _model.baseUrl });
				return completionsStream(_model, _context, options) as any;
			},
			responsesToolStream: (_model: any, _context: any, options: any) => {
				calls.push({ api: "responses-tools", options, baseUrl: _model.baseUrl });
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

test("retries a claimed upstream error without exposing it as assistant output", async () => {
	const selectedModel = model("gpt-5.6-terra");
	let responsesCalls = 0;
	const claimedError = completedMessage(selectedModel, "[Codex error: Our servers are currently overloaded. Please try again later.]");
	const answer = completedMessage(selectedModel, "Retry succeeded");
	const helper = helpersWith({
		responsesToolStream: () => {
			responsesCalls++;
			const message = responsesCalls === 1 ? claimedError : answer;
			return (async function* () {
				yield { type: "start", partial: message };
				yield { type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message };
				yield { type: "done", reason: "stop", message };
			})();
		},
	});
	configureEmptyPreferredRoutes("retry-claimed-upstream-error");

	helper.streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "retry-claimed-upstream-error",
	});
	await helper.sink.finished;

	assert.equal(responsesCalls, 2);
	assert.equal(helper.sink.events.filter((event) => event.type === "start").length, 1);
	assert.equal(helper.sink.events.filter((event) => event.type === "text_delta").length, 1);
	assert.equal(helper.sink.events.at(-1).message.content[0].text, "Retry succeeded");
});

test("does not treat ordinary Codex-error text as an upstream error", async () => {
	const selectedModel = model("gpt-5.6-terra");
	let responsesCalls = 0;
	const answer = completedMessage(selectedModel, "I saw [Codex error: example] in a log.");
	const helper = helpersWith({
		responsesToolStream: () => {
			responsesCalls++;
			return (async function* () {
				yield { type: "start", partial: answer };
				yield { type: "text_delta", contentIndex: 0, delta: answer.content[0].text, partial: answer };
				yield { type: "done", reason: "stop", message: answer };
			})();
		},
	});
	configureEmptyPreferredRoutes("ordinary-codex-error-text");

	helper.streamSimple(selectedModel, { messages: [], tools: [] } as any, { sessionId: "ordinary-codex-error-text" });
	await helper.sink.finished;

	assert.equal(responsesCalls, 1);
	assert.equal(helper.sink.events.at(-1).type, "done");
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

test("stops retrying immediately when Pi aborts the request", async () => {
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

	const aborter = new AbortController();
	setTimeout(() => aborter.abort(), 0);
	helper.streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "retry-empty-exhausted",
		signal: aborter.signal,
	});
	await helper.sink.finished;

	assert.equal(responsesCalls, 1);
	assert.equal(helper.sink.events.at(-1).type, "error");
	assert.equal(helper.sink.events.at(-1).reason, "aborted");
});

test("rewrites Surplus base URLs for savings routing but leaves InferHub direct", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-surplus-savings-"));
	try {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "surplus-intelligence.json"), JSON.stringify({ routing: { minimumSavings: 50 } }));
		const configureTrusted = (sessionId: string) =>
			configurePreferredProviders({
				sessionId,
				cwd,
				modelRegistry: {} as any,
				mode: "print",
				ui: { setStatus() {} } as any,
				trusted: true,
			});

		for (const [sessionId, selectedModel, expectedBaseUrl] of [
			["savings-surplus", model("kimi-k2.7-code"), "https://example.test/v1/min50/v1"],
			["savings-inferhub", model("ag/gemini-3.7-flash-high", "inferhub"), "https://example.test/v1"],
		] as const) {
			const answer = completedMessage(selectedModel, "pong");
			const helper = helpersWith({
				completionsStream: () =>
					(async function* () {
						yield { type: "start", partial: answer };
						yield { type: "text_delta", contentIndex: 0, delta: "pong", partial: answer };
						yield { type: "done", reason: "stop", message: answer };
					})() as any,
			});
			configureTrusted(sessionId);
			helper.streamSimple(selectedModel, { messages: [], tools: [] } as any, { sessionId });
			await helper.sink.finished;
			assert.equal(helper.calls[0].baseUrl, expectedBaseUrl, `${selectedModel.provider} base URL`);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
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
test("clamps InferHub xhigh to an advertised level instead of sending a raw contract-violating value", async () => {
	const selectedModel = model("ag/gemini-3.6-flash-high", "inferhub");
	selectedModel.reasoning = true;
	selectedModel.thinkingLevelMap = { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", max: null, xhigh: null };
	const answer = completedMessage(selectedModel, "ok");
	const source = (async function* () {
		yield { type: "start", partial: answer };
		yield { type: "done", reason: "stop", message: answer };
	})();
	const helper = helpersWith({
		completionsStream: () => source,
	});
	configureEmptyPreferredRoutes("inferhub-clamped");

	helper.streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "inferhub-clamped",
		reasoning: "xhigh",
	});
	await helper.sink.finished;

	// xhigh is clamped upward to "high" (max advertised is high, max null).
	assert.equal(helper.calls[0].options.reasoningEffort, "high");
	assert.equal(helper.calls[0].options.reasoningSummary, undefined);
	// onPayload injects include_reasoning and reasoning_effort.
	const payload = helper.calls[0].options.onPayload({} as any, selectedModel) as any;
	assert.equal(payload.include_reasoning, "summary");
	assert.equal(payload.reasoning_effort, "high");
});

test("surplus models pass max through unchanged when no thinkingLevelMap exists", async () => {
	const selectedModel = model("gpt-4.1"); // surplus-intelligence, no map
	selectedModel.reasoning = true;
	const answer = completedMessage(selectedModel, "ok");
	const source = (async function* () {
		yield { type: "start", partial: answer };
		yield { type: "done", reason: "stop", message: answer };
	})();
	const helper = helpersWith({
		completionsStream: () => source,
	});
	configureEmptyPreferredRoutes("surplus-max-pass-through");

	helper.streamSimple(selectedModel, { messages: [], tools: [] } as any, {
		sessionId: "surplus-max-pass-through",
		reasoning: "max",
	});
	await helper.sink.finished;

	assert.equal(helper.calls[0].options.reasoningEffort, "max");
});

// --- Phase 2: prepaid-fill retry caps ---

test("maxAttemptsForModel caps Bu0y at a single retry", () => {
	const bu0yModel = { provider: "bu0y" } as any;
	assert.equal(maxAttemptsForModel(bu0yModel), 2);
});

test("maxAttemptsForModel keeps the generous budget for other providers", () => {
	for (const provider of ["surplus-intelligence", "inferhub", "cheaper-inference", "surp", "ruvicode"]) {
		assert.equal(maxAttemptsForModel({ provider } as any), 15, provider);
	}
	assert.equal(maxAttemptsForModel({ provider: "unknown" } as any), 15);
});

// --- Phase 3: the paying fetch survives the preferred-route auth rewrite ---

test("optionsForUpstream preserves a caller fetch across the route auth rewrite", () => {
	const paying = (async () => new Response()) as typeof fetch;
	const route = {
		auth: { apiKey: "route-key", headers: { "x-route": "1" }, env: { ROUTE_ENV: "x" } },
	} as any;
	const rewritten = optionsForUpstream(
		{ fetch: paying, apiKey: "surplus-key", headers: { Authorization: "Bearer surplus-key" } },
		route,
	);
	assert.equal(rewritten.fetch, paying, "the paying fetch must survive");
	assert.equal(rewritten.apiKey, "route-key");
	assert.deepEqual(rewritten.headers, { "x-route": "1" });
});

test("optionsForUpstream without a route copies options, fetch included", () => {
	const paying = (async () => new Response()) as typeof fetch;
	const original = { fetch: paying, apiKey: "k" };
	const out = optionsForUpstream(original, undefined);
	assert.equal(out.fetch, paying);
	assert.notEqual(out, original, "a copy, so payment injection never mutates the caller's options");
});

// --- Latest-Pi compatibility: keyless auth and anthropic variant gating ---

test("stripAuthorizationFetch drops the Authorization header, keeps the rest", async () => {
	const seen: { hasAuth: boolean; other: string | null }[] = [];
	const stub: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		seen.push({ hasAuth: request.headers.has("authorization"), other: request.headers.get("x-other") });
		return new Response("{}", { status: 200 });
	};
	const stripped = stripAuthorizationFetch(stub);
	await stripped("https://surp.ivc.lol/v1/chat/completions", {
		method: "POST",
		headers: { Authorization: `Bearer ${KEYLESS_SENTINEL}`, "x-other": "1" },
		body: "{}",
	});
	assert.deepEqual(seen, [{ hasAuth: false, other: "1" }]);
});

test("stripAuthorizationFetch passes requests without Authorization through untouched", async () => {
	const seen: string[] = [];
	const stub: typeof fetch = async (input, init) => {
		seen.push(new Request(input, init).url);
		return new Response("{}", { status: 200 });
	};
	const stripped = stripAuthorizationFetch(stub);
	const response = await stripped("https://surp.ivc.lol/v1/models");
	assert.equal(response.status, 200);
	assert.equal(seen.length, 1);
});

test("only gateways with a confirmed Anthropic endpoint spawn -anthropic variants", () => {
	const claudeCatalog = [{ id: "claude-fable-5", name: "Claude Fable 5" }];
	const withSupport = PROVIDERS.filter((d) => d.supportsAnthropicMessages).map((d) => d.id);
	assert.deepEqual([...withSupport].sort(), ["cheaper-inference", "inferhub", "surplus-intelligence"]);
	// The filter the registration loop uses.
	for (const descriptor of PROVIDERS) {
		const variants = descriptor.supportsAnthropicMessages ? anthropicClaudeModels(claudeCatalog) : [];
		if (["surp", "bu0y", "ruvicode"].includes(descriptor.id)) {
			assert.deepEqual(variants, [], `${descriptor.id} must not spawn an -anthropic variant`);
		}
	}
});

test("a Surp combo naming a Claude model does not become an -anthropic model", () => {
	// Regression: combo names embed the resolved model ("surp/value → claude-…"),
	// and the id/name match would previously register it against a
	// nonexistent /anthropic endpoint.
	const surp = PROVIDERS.find((d) => d.id === "surp")!;
	const combo = mapGatewayModel({ combo: "surp/value", resolved_model: "claude-sonnet-5" }, surp);
	assert.match(combo.name, /claude/);
	assert.equal(surp.supportsAnthropicMessages ?? false, false);
});


test("permanent 4xx errors are not retried through the backoff budget", async () => {
	const selectedModel = model("surp/value");
	let attempts = 0;
	const helper = helpersWith({
		completionsStream: () => {
			attempts += 1;
			return (async function* () {
				yield {
					type: "error",
					reason: "error",
					error: { role: "assistant", content: [], errorMessage: "402 Payment Required", stopReason: "error" },
				};
			})();
		},
	});
	configureEmptyPreferredRoutes("perm-402");

	helper.streamSimple({ ...selectedModel, provider: "surp" }, { messages: [], tools: [] } as any, {
		sessionId: "perm-402",
	});
	await helper.sink.finished;

	assert.equal(attempts, 1, "a 402 surfaces immediately, not after 15 retries");
	const last = helper.sink.events.at(-1);
	assert.equal(last.type, "error");
	assert.match(last.error.errorMessage, /402/);
});

test("transient errors still retry through the backoff budget", async () => {
	const selectedModel = model("kimi-k2.7-code");
	let attempts = 0;
	const answer = completedMessage(selectedModel, "recovered");
	const helper = helpersWith({
		completionsStream: () => {
			attempts += 1;
			if (attempts < 2) {
				return (async function* () {
					yield {
						type: "error",
						reason: "error",
						error: { role: "assistant", content: [], errorMessage: "502 Bad Gateway", stopReason: "error" },
					};
				})();
			}
			return (async function* () {
				yield { type: "start", partial: answer };
				yield { type: "text_delta", contentIndex: 0, delta: "recovered", partial: answer };
				yield { type: "done", reason: "stop", message: answer };
			})();
		},
	});
	configureEmptyPreferredRoutes("transient-502");

	helper.streamSimple(selectedModel, { messages: [], tools: [] } as any, { sessionId: "transient-502" });
	await helper.sink.finished;

	assert.equal(attempts, 2, "a 502 retries and recovers");
	assert.equal(helper.sink.events.at(-1).type, "done");
});
