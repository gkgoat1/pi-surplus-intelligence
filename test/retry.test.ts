import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { loadProvidersFileConfig } from "../src/provider-config.ts";
import {
	DEFAULT_DISCOVERY_RETRY,
	DEFAULT_REQUEST_RETRY,
	mergeRetrySettings,
	resolveDiscoveryPolicy,
	resolveRequestPolicy,
	retryDelayMs,
	withRetries,
} from "../src/retry.ts";
import { createGatewayStreamSimple } from "../src/stream.ts";
import { configurePreferredProviders } from "../src/preferred-providers.ts";
import { createGatewayProviders } from "../providers.ts";
import type { StreamHelpers } from "../src/types.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryConfig(config: unknown): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-surplus-retry-"));
	directories.push(cwd);
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "surplus-intelligence.json"), JSON.stringify(config));
	return cwd;
}

// --- config parsing ---

test("parses the top-level retry section, including \"infinite\"", () => {
	const cwd = temporaryProjectWith({
		retry: {
			discovery: { maxAttempts: 3, baseDelayMs: 250 },
			requests: { maxAttempts: "infinite", maxDelayMs: 5000 },
		},
	});
	const { retry, diagnostics } = loadProvidersFileConfig(cwd);
	assert.deepEqual(diagnostics, []);
	assert.deepEqual(retry?.discovery, { maxAttempts: 3, baseDelayMs: 250 });
	assert.deepEqual(retry?.requests, { maxAttempts: Infinity, maxDelayMs: 5000 });
});

test("parses per-provider retry overrides", () => {
	const cwd = temporaryProjectWith({
		providers: {
			"surplus-intelligence": {
				apiKey: "key",
				retry: { requests: { maxAttempts: "infinite" }, discovery: { maxAttempts: 2 } },
			},
		},
	});
	const { providers, diagnostics } = loadProvidersFileConfig(cwd);
	assert.deepEqual(diagnostics, []);
	assert.deepEqual(providers["surplus-intelligence"].retry?.requests, { maxAttempts: Infinity });
	assert.deepEqual(providers["surplus-intelligence"].retry?.discovery, { maxAttempts: 2 });
});

test("malformed retry values warn and are ignored, leaving the rest intact", () => {
	const cwd = temporaryProjectWith({
		retry: {
			discovery: { maxAttempts: 0, baseDelayMs: -5, maxDelayMs: 1000, bogus: true },
			requests: { maxAttempts: "forever" },
		},
		providers: { inferhub: { retry: "yes" } },
	});
	const { retry, providers, diagnostics } = loadProvidersFileConfig(cwd);
	assert.equal(retry?.discovery?.maxAttempts, undefined);
	assert.equal(retry?.discovery?.baseDelayMs, undefined);
	assert.equal(retry?.discovery?.maxDelayMs, 1000);
	assert.equal(retry?.requests?.maxAttempts, undefined);
	assert.equal(providers.inferhub.retry, undefined);
	assert.ok(diagnostics.some((d) => d.includes("maxAttempts")));
	assert.ok(diagnostics.some((d) => d.includes("baseDelayMs")));
	assert.ok(diagnostics.some((d) => d.includes("bogus")));
	assert.ok(diagnostics.some((d) => d.includes("providers.inferhub.retry")));
});

test("a missing retry section yields undefined and no diagnostics", () => {
	const cwd = temporaryProjectWith({ providers: {} });
	const { retry, diagnostics } = loadProvidersFileConfig(cwd);
	assert.equal(retry, undefined);
	assert.deepEqual(diagnostics, []);
});

function temporaryProjectWith(config: unknown): string {
	return temporaryConfig(config);
}

// --- policy resolution ---

test("request policy defaults preserve the historical budgets", () => {
	assert.equal(resolveRequestPolicy("surplus-intelligence").maxAttempts, DEFAULT_REQUEST_RETRY.maxAttempts);
	assert.equal(resolveRequestPolicy("unknown-provider").maxAttempts, DEFAULT_REQUEST_RETRY.maxAttempts);
	// Bu0y's prepaid fills get a single retry by default.
	assert.equal(resolveRequestPolicy("bu0y").maxAttempts, 2);
});

test("an explicit maxAttempts overrides the Bu0y prepaid-fill cap", () => {
	assert.equal(resolveRequestPolicy("bu0y", { maxAttempts: 5 }).maxAttempts, 5);
	assert.equal(resolveRequestPolicy("bu0y", { maxAttempts: Infinity }).maxAttempts, Infinity);
	// Partial settings keep the Bu0y cap while overriding delays.
	const partial = resolveRequestPolicy("bu0y", { baseDelayMs: 100 });
	assert.equal(partial.maxAttempts, 2);
	assert.equal(partial.baseDelayMs, 100);
	assert.equal(partial.maxDelayMs, DEFAULT_REQUEST_RETRY.maxDelayMs);
});

test("discovery policy defaults to a single attempt", () => {
	assert.deepEqual(resolveDiscoveryPolicy(), DEFAULT_DISCOVERY_RETRY);
	assert.deepEqual(resolveDiscoveryPolicy({ maxAttempts: 4, maxDelayMs: 500 }), {
		maxAttempts: 4,
		baseDelayMs: DEFAULT_DISCOVERY_RETRY.baseDelayMs,
		maxDelayMs: 500,
	});
});

test("mergeRetrySettings lets per-provider fields win individually", () => {
	assert.deepEqual(
		mergeRetrySettings({ maxAttempts: 3, baseDelayMs: 100 }, { baseDelayMs: 50 }),
		{ maxAttempts: 3, baseDelayMs: 50 },
	);
	assert.equal(mergeRetrySettings(undefined, undefined), undefined);
});

test("retryDelayMs doubles from the base and caps at the max", () => {
	const policy = { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 250 };
	assert.equal(retryDelayMs(policy, 1), 100);
	assert.equal(retryDelayMs(policy, 2), 200);
	assert.equal(retryDelayMs(policy, 3), 250);
	assert.equal(retryDelayMs(policy, 9), 250);
});

// --- withRetries ---

test("withRetries succeeds after transient failures and reports each retry", async () => {
	let calls = 0;
	const retries: number[] = [];
	const result = await withRetries(
		async () => {
			calls++;
			if (calls < 3) throw new Error(`failure ${calls}`);
			return "ok";
		},
		{ maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
		{ onRetry: ({ attempt }) => retries.push(attempt) },
	);
	assert.equal(result, "ok");
	assert.equal(calls, 3);
	assert.deepEqual(retries, [1, 2]);
});

test("withRetries exhausts the budget and rejects with the last failure", async () => {
	let calls = 0;
	await assert.rejects(
		withRetries(
			async () => {
				calls++;
				throw new Error(`failure ${calls}`);
			},
			{ maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
		),
		/failure 2/,
	);
	assert.equal(calls, 2);
});

test("an infinite budget retries until success", async () => {
	let calls = 0;
	const result = await withRetries(
		async () => {
			calls++;
			if (calls <= 25) throw new Error("still down");
			return "ok";
		},
		{ maxAttempts: Infinity, baseDelayMs: 1, maxDelayMs: 1 },
	);
	assert.equal(result, "ok");
	assert.equal(calls, 26);
});

test("abort during the backoff wait stops an infinite retry immediately", async () => {
	const aborter = new AbortController();
	let calls = 0;
	const start = Date.now();
	setTimeout(() => aborter.abort(), 25);
	await assert.rejects(
		withRetries(
			async () => {
				calls++;
				throw new Error("down");
			},
			{ maxAttempts: Infinity, baseDelayMs: 60_000, maxDelayMs: 60_000 },
			{ signal: aborter.signal },
		),
		/aborted/,
	);
	assert.ok(Date.now() - start < 5_000, "abort must not wait out the backoff");
	assert.equal(calls, 1);
});

// --- stream integration ---

function model(id: string, provider = "surplus-intelligence"): Model<any> {
	return {
		id,
		name: id,
		provider,
		api: "surplus-openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
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

	async *[Symbol.asyncIterator](): AsyncIterator<any> {}
}

function failingThenSucceeding(selectedModel: Model<any>, failures: number) {
	const answer = completedMessage(selectedModel, "recovered");
	let calls = 0;
	return {
		source: () => {
			calls++;
			const attempt = calls;
			return (async function* () {
				if (attempt <= failures) {
					const failed = completedMessage(selectedModel, "");
					failed.stopReason = "error";
					failed.errorMessage = "connect ECONNREFUSED 10.0.0.1:443";
					yield { type: "start", partial: failed };
					yield { type: "error", reason: "error", error: failed };
					return;
				}
				yield { type: "start", partial: answer };
				yield { type: "text_delta", contentIndex: 0, delta: answer.content[0].text, partial: answer };
				yield { type: "done", reason: "stop", message: answer };
			})() as any;
		},
		calls: () => calls,
	};
}

function streamHarness(source: (model: any, context: any, options: any) => AsyncIterable<any>, retrySettings?: any) {
	let sink: RecordingStream | undefined;
	const streamSimple = createGatewayStreamSimple(
		{
			completionsStream: source,
			responsesStream: (() => {
				throw new Error("responsesStream not expected");
			}) as any,
			createAssistantMessageEventStream: () => {
				sink = new RecordingStream();
				return sink;
			},
		} as unknown as StreamHelpers,
		retrySettings,
	);
	return {
		streamSimple,
		get sink() {
			if (!sink) throw new Error("createAssistantMessageEventStream was not called");
			return sink;
		},
	};
}

let sessionCounter = 0;
function freshSession(): string {
	const sessionId = `retry-test-${++sessionCounter}`;
	configurePreferredProviders({
		sessionId,
		cwd: process.cwd(),
		modelRegistry: {} as any,
		mode: "print",
		ui: { setStatus() {} } as any,
		trusted: false,
	});
	return sessionId;
}

test("a configured request budget caps pre-output retries, then surfaces the error", async () => {
	const selectedModel = model("kimi-k2.7-code");
	const failing = failingThenSucceeding(selectedModel, Infinity);
	const harness = streamHarness(failing.source, () => ({ maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 }));
	const sessionId = freshSession();

	harness.streamSimple(selectedModel, { messages: [], tools: [] } as any, { sessionId });
	await harness.sink.finished;

	assert.equal(failing.calls(), 3);
	const last = harness.sink.events.at(-1);
	assert.equal(last.type, "error");
	assert.match(last.error.errorMessage, /ECONNREFUSED/);
});

test("an infinite request budget rides out a long outage instead of failing the agent", async () => {
	const selectedModel = model("kimi-k2.7-code");
	const flaky = failingThenSucceeding(selectedModel, 20);
	const harness = streamHarness(flaky.source, () => ({ maxAttempts: Infinity, baseDelayMs: 1, maxDelayMs: 2 }));
	const sessionId = freshSession();

	harness.streamSimple(selectedModel, { messages: [], tools: [] } as any, { sessionId });
	await harness.sink.finished;

	assert.equal(flaky.calls(), 21);
	assert.equal(harness.sink.events.filter((event) => event.type === "error").length, 0);
	assert.equal(harness.sink.events.at(-1).type, "done");
	assert.equal(harness.sink.events.at(-1).message.content[0].text, "recovered");
});

test("per-provider settings only apply to their own provider", async () => {
	const selectedModel = model("glm4.6", "bu0y");
	const failing = failingThenSucceeding(selectedModel, Infinity);
	// Settings target another provider; bu0y keeps its default 2-attempt cap.
	const harness = streamHarness(failing.source, (providerId: string) =>
		providerId === "surplus-intelligence" ? { maxAttempts: Infinity, baseDelayMs: 1 } : undefined,
	);
	const sessionId = freshSession();

	harness.streamSimple(selectedModel, { messages: [], tools: [] } as any, { sessionId });
	await harness.sink.finished;

	assert.equal(failing.calls(), 2);
	assert.equal(harness.sink.events.at(-1).type, "error");
});

test("a thrown failure on Bu0y's final attempt surfaces an error instead of ending silently", async () => {
	const selectedModel = model("glm4.6", "bu0y");
	let calls = 0;
	const harness = streamHarness(() => {
		calls++;
		return (async function* () {
			throw new Error("socket hangup");
		})() as any;
	});
	const sessionId = freshSession();

	harness.streamSimple(selectedModel, { messages: [], tools: [] } as any, { sessionId });
	await harness.sink.finished;

	assert.equal(calls, 2);
	const last = harness.sink.events.at(-1);
	assert.equal(last.type, "error");
	assert.match(last.error.errorMessage, /socket hangup/);
});

// --- discovery retry through the pi-ai entrypoint ---

test("createGatewayProviders retries an unreachable catalog per the retry config", async () => {
	const cwd = temporaryConfig({
		retry: { discovery: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } },
	});
	let fetches = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		fetches++;
		if (fetches < 3) throw new Error("connect ECONNREFUSED");
		return new Response(JSON.stringify({ data: [{ id: "live-model", inputPer1m: 1, outputPer1m: 2 }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	try {
		const providers = await createGatewayProviders({
			providers: ["bu0y"],
			configDir: cwd,
			helpers: stubHelpers(),
		});
		assert.equal(fetches, 3);
		assert.deepEqual(providers[0].getModels().map((m: any) => m.id), ["live-model"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("an explicit retry option wins over the config file", async () => {
	const cwd = temporaryConfig({
		retry: { discovery: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1 } },
	});
	let fetches = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		fetches++;
		throw new Error("connect ECONNREFUSED");
	}) as typeof fetch;
	try {
		const providers = await createGatewayProviders({
			providers: ["bu0y"],
			configDir: cwd,
			retry: { discovery: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } },
			helpers: stubHelpers(),
		});
		assert.equal(fetches, 2);
		// Discovery exhausted: the fallback list is registered instead.
		assert.ok(providers[0].getModels().some((m: any) => m.id === "glm4.6"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

function stubHelpers(): StreamHelpers {
	return {
		completionsStream: (() => {
			throw new Error("completionsStream not expected");
		}) as any,
		responsesStream: (() => {
			throw new Error("responsesStream not expected");
		}) as any,
		createAssistantMessageEventStream: (() => {
			const events: any[] = [];
			return {
				push(event: any) {
					events.push(event);
				},
				end() {},
				[Symbol.asyncIterator]: async function* () {
					yield* events;
				},
				result: async () => events.at(-1),
			} as any;
		}) as any,
	};
}
