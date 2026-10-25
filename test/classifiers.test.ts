import assert from "node:assert/strict";
import { test } from "node:test";
import {
	classifierFallbackModels,
	createDecisionsClassifier,
	DECISIONS_API,
	isDecisionsModel,
	mapClassifierModel,
} from "../src/classifiers.ts";
import { mapGatewayModel } from "../src/models.ts";
import { SURPLUS_INTELLIGENCE, SURP } from "../src/constants.ts";
import { KEYLESS_SENTINEL } from "../src/stream.ts";
import type { ClassifySystemOne } from "../src/types.ts";

// The real jev-1.13 catalog entry shape (api.surplusintelligence.ai/v1/models,
// recorded 2026-10-19).
const JEV_ENTRY = {
	id: "jev-1.13",
	name: "JEV 1.13 (TypeSafe)",
	description: "TypeSafe JEV 1.13 decisions model",
	architecture: { modality: "decisions", input_modalities: ["text"], output_modalities: ["decisions"] },
	pricing: { prompt: "0.0000000420", completion: "0.0000000000" },
	supported_parameters: ["decisions", "non_streaming", "native_schema", "context_32k"],
};

test("isDecisionsModel detects the decisions modality and parameter", () => {
	assert.equal(isDecisionsModel(JEV_ENTRY), true);
	assert.equal(isDecisionsModel({ id: "kimi-k2.7-code", architecture: { modality: "text" } }), false);
	assert.equal(isDecisionsModel({ id: "x", supported_parameters: ["decisions"] }), true);
	assert.equal(isDecisionsModel(null), false);
	assert.equal(isDecisionsModel({}), false);
});

test("mapClassifierModel maps a Jev entry to a classifier model", () => {
	const mapped = mapClassifierModel(JEV_ENTRY, SURPLUS_INTELLIGENCE);
	assert.equal(mapped.id, "jev-1.13");
	assert.equal(mapped.type, "classifier");
	assert.equal(mapped.api, DECISIONS_API);
	assert.equal(mapped.name, "JEV 1.13 (TypeSafe)");
	assert.equal(mapped.contextWindow, 32_768);
	assert.deepEqual(mapped.input, ["text"]);
	assert.equal(mapped.cost.output, 0);
	assert.ok(mapped.cost.input > 0, "input metering is priced");
});

test("mapClassifierModel widens context for 64k and 262k entries", () => {
	const with64k = { ...JEV_ENTRY, supported_parameters: ["decisions", "context_64k"] };
	assert.equal(mapClassifierModel(with64k, SURPLUS_INTELLIGENCE).contextWindow, 65_536);
	const with262k = { ...JEV_ENTRY, supported_parameters: ["decisions", "context_64k", "long_context_262k"] };
	assert.equal(mapClassifierModel(with262k, SURPLUS_INTELLIGENCE).contextWindow, 262_144);
});

test("mapClassifierModel rejects non-decisions and id-less entries", () => {
	assert.equal(mapClassifierModel({ id: "kimi-k2.7-code" }, SURPLUS_INTELLIGENCE), undefined);
	assert.equal(mapClassifierModel({ architecture: { modality: "decisions" } }, SURPLUS_INTELLIGENCE), undefined);
});

test("decisions entries never map to chat models", () => {
	assert.equal(mapGatewayModel(JEV_ENTRY, SURPLUS_INTELLIGENCE), undefined);
});

test("fallback classifiers are the two Jev releases", () => {
	const models = classifierFallbackModels(SURPLUS_INTELLIGENCE);
	assert.deepEqual(models.map((m) => m.id), ["jev-1.14", "jev-1.13"]);
	assert.ok(models.every((m) => m.type === "classifier" && m.api === DECISIONS_API));
});

// --- transport behavior, with a stub classifySystemOne runner ---

const MODEL = {
	id: "jev-1.13",
	type: "classifier",
	api: DECISIONS_API,
	provider: "surplus-intelligence",
	baseUrl: "https://api.surplusintelligence.ai",
	// calculateCost reads model.cost; mapped classifier models carry it.
	cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
} as any;

const CONTEXT = {
	state: { message: "I love this" },
	questions: {
		sentiment: {
			type: "choice",
			instructions: "How does the user feel?",
			criteria: { positive: "happy", negative: "unhappy" },
		},
	},
} as any;

function stubRunner(capture: { url?: string; payload?: any; options?: any }): ClassifySystemOne {
	return async (transport, model, context, options) => {
		capture.url = transport.url(model).href;
		capture.payload = transport.payload(model, { state: context.state, questions: context.questions });
		capture.options = options;
		return {
			api: DECISIONS_API,
			provider: "surplus-intelligence",
			model: "jev-1.13",
			answers: {},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	};
}

test("the transport posts to the /v1/decisions rail with the System One envelope", async () => {
	const capture: { url?: string; payload?: any } = {};
	const classifier = createDecisionsClassifier(stubRunner(capture));
	await classifier.classify(MODEL, CONTEXT, { apiKey: "real-key" });
	assert.equal(capture.url, "https://api.surplusintelligence.ai/v1/decisions");
	assert.equal(capture.payload.model, "jev-1.13");
	assert.deepEqual(capture.payload.state, { message: "I love this" });
	assert.ok("sentiment" in capture.payload.questions);
});

test("a real API key passes through with the caller's fetch untouched", async () => {
	const capture: { options?: any } = {};
	const classifier = createDecisionsClassifier(stubRunner(capture));
	const callerFetch = (async () => new Response()) as typeof fetch;
	await classifier.classify(MODEL, CONTEXT, { apiKey: "real-key", fetch: callerFetch });
	assert.equal(capture.options.apiKey, "real-key");
	assert.equal(capture.options.fetch, callerFetch);
});

test("the keyless sentinel injects a stripping fetch so no Bearer token leaks", async () => {
	const capture: { options?: any } = {};
	const classifier = createDecisionsClassifier(stubRunner(capture));
	// A caller-supplied fetch is wrapped rather than replaced: the wrapper
	// drops Authorization before the request reaches the caller's fetch.
	const seen: (string | null)[] = [];
	const inner: typeof fetch = async (input: any, init?: any) => {
		seen.push(new Request(input, init).headers.get("authorization"));
		return new Response("{}", { status: 200 });
	};
	await classifier.classify(MODEL, CONTEXT, { apiKey: KEYLESS_SENTINEL, fetch: inner });
	// The runner receives a truthy apiKey (its presence check passes)…
	assert.equal(capture.options.apiKey, KEYLESS_SENTINEL);
	// …and a fetch wrapper around the caller's fetch.
	const wrapped = capture.options.fetch;
	assert.equal(typeof wrapped, "function");
	assert.notEqual(wrapped, inner);
	await wrapped(
		new Request("https://api.surplusintelligence.ai/v1/decisions", {
			method: "POST",
			headers: { authorization: `Bearer ${KEYLESS_SENTINEL}`, "content-type": "application/json" },
			body: "{}",
		}),
	);
	assert.deepEqual(seen, [null], "no Authorization header reaches the wire");
});

test("no key at all also gets the sentinel + stripping fetch treatment", async () => {
	const capture: { options?: any } = {};
	const classifier = createDecisionsClassifier(stubRunner(capture));
	await classifier.classify(MODEL, CONTEXT, {});
	assert.equal(capture.options.apiKey, KEYLESS_SENTINEL);
	assert.notEqual(capture.options.fetch, undefined);
});

// --- integration with the real pi-ai System One runner ---

test("the real classifySystemOne runner drives the Surplus transport end to end", async () => {
	const { classifySystemOne } = await import("@earendil-works/pi-ai/api/system-one-shared");
	const classifier = createDecisionsClassifier(classifySystemOne as unknown as ClassifySystemOne);

	const seen: { url: string; auth: string | null; body: any }[] = [];
	const wire: typeof fetch = async (input: any, init?: any) => {
		const request = new Request(input, init);
		seen.push({ url: request.url, auth: request.headers.get("authorization"), body: await request.json() });
		return new Response(
			JSON.stringify({
				answers: {
					sentiment: { type: "choice", choice: "positive", probabilities: { positive: 0.9, negative: 0.1 }, confidence: 0.9 },
					is_greeting: { type: "noul", noul: 0.98 },
					urgency: { type: "score", score: 1.2, confidence: 0.7 },
				},
				usage: { input_tokens: 120, output_tokens: 0 },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};

	const result = await classifier.classify(MODEL, {
		state: { message: "hello, I love this" },
		questions: {
			sentiment: { type: "choice", instructions: "How does the user feel?", criteria: { positive: "happy", negative: "unhappy" } },
			is_greeting: { type: "bool", instructions: "Is this a greeting?", criteria: { true: "greeting", false: "not a greeting" } },
			urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "high"] },
		},
	} as any, { apiKey: "real-key", fetch: wire });

	// The request hit the Surplus decisions rail with Bearer auth.
	assert.equal(seen.length, 1);
	assert.equal(seen[0].url, "https://api.surplusintelligence.ai/v1/decisions");
	assert.equal(seen[0].auth, "Bearer real-key");
	assert.equal(seen[0].body.model, "jev-1.13");
	// Public bool mapped to wire-level noul.
	assert.equal(seen[0].body.questions.is_greeting.type, "noul");
	assert.equal(seen[0].body.questions.sentiment.type, "choice");

	// The response parsed into ClassifierResult answers.
	assert.equal(result.stopReason, "stop");
	assert.equal(result.answers.sentiment.type, "choice");
	assert.equal((result.answers.sentiment as any).choice, "positive");
	assert.deepEqual((result.answers.sentiment as any).probabilities, { positive: 0.9, negative: 0.1 });
	assert.equal(result.answers.is_greeting.type, "bool");
	assert.equal((result.answers.is_greeting as any).probability, 0.98);
	assert.equal(result.answers.urgency.type, "score");
	assert.equal((result.answers.urgency as any).score, 1.2);
	assert.ok(result.usage, "token usage is reported");
});

test("a 402 from the rail surfaces as an error result, not a throw", async () => {
	const { classifySystemOne } = await import("@earendil-works/pi-ai/api/system-one-shared");
	const classifier = createDecisionsClassifier(classifySystemOne as unknown as ClassifySystemOne);
	const wire: typeof fetch = async () =>
		new Response(JSON.stringify({ error: "payment-required" }), { status: 402, headers: { "content-type": "application/json" } });
	const result = await classifier.classify(MODEL, CONTEXT, { apiKey: "real-key", fetch: wire });
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /402/);
});

test("the transport satisfies pi-ai 1.4's contract: detectCompat with TypeSafe-native defaults", async () => {
	const capture: { transport?: any } = {};
	const spyRunner: ClassifySystemOne = async (transport, model, context, options) => {
		capture.transport = transport;
		return { api: DECISIONS_API, provider: "surplus-intelligence", model: model.id, answers: {}, stopReason: "stop", timestamp: Date.now() };
	};
	const classifier = createDecisionsClassifier(spyRunner);
	await classifier.classify(MODEL, CONTEXT, { apiKey: "real-key" });
	assert.equal(typeof capture.transport.detectCompat, "function", "pi-ai 1.4 calls detectCompat for image requests");
	assert.deepEqual(capture.transport.detectCompat(MODEL), { imageInput: "assets", sendImageOptInHeader: true });
});
