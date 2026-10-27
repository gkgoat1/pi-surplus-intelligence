import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import { createGatewayProviders } from "../providers.ts";
import { X402_FETCH_MARKER } from "../src/x402/hook.ts";
import { KEYLESS_SENTINEL } from "../src/stream.ts";
import type { StreamHelpers } from "../src/types.ts";

const TEST_KEY = `0x${"0".repeat(63)}1`;

/** Minimal helpers stub: the completions stream just records its options. */
function stubHelpers(calls: { options: any }[]): StreamHelpers {
	return {
		completionsStream: ((_model: any, _context: any, options: any) => {
			calls.push({ options });
			return (async function* () {
				yield { type: "error", reason: "error", error: { role: "assistant", content: [], errorMessage: "402 Payment Required", stopReason: "error" } };
			})();
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
				result: async () => events.at(-1)?.error,
			} as any;
		}) as any,
	};
}

const noDiscovery = { skipDiscovery: true, configDir: "/nonexistent-config-dir" };

test("creates one provider per gateway with models, auth, and streamSimple", async () => {
	const providers = await createGatewayProviders(noDiscovery);
	assert.deepEqual(
		providers.map((p) => p.id).sort(),
		["bu0y", "cheaper-inference", "inferhub", "ruvicode", "surp", "surplus-intelligence"],
	);
	for (const provider of providers) {
		assert.ok(provider.getAllModels!().length > 0, provider.id);
		assert.ok(provider.getModels().length > 0, `${provider.id} has chat models`);
		assert.ok(provider.auth.apiKey, `${provider.id} has api-key auth semantics`);
		assert.equal(typeof provider.streamSimple, "function", provider.id);
	}
});

test("the providers filter limits which gateways are created", async () => {
	const providers = await createGatewayProviders({ ...noDiscovery, providers: ["surp"] });
	assert.deepEqual(providers.map((p) => p.id), ["surp"]);
});

test("the surplus provider carries classifier models and a classify implementation", async () => {
	const providers = await createGatewayProviders(noDiscovery);
	const surplus = providers.find((p) => p.id === "surplus-intelligence");
	assert.ok(surplus);
	const classifiers = surplus.getAllModels!().filter((m: any) => m.type === "classifier");
	assert.deepEqual(classifiers.map((m: any) => m.id).sort(), ["jev-1.13", "jev-1.14"]);
	assert.equal(typeof (surplus as any).classify, "function");
	// Chat models stay chat-typed; classifiers never leak into getModels().
	assert.ok(surplus.getModels().length > 0);
	assert.ok(surplus.getModels().every((m: any) => m.type === undefined || m.type === "chat"));
	// Non-surplus providers have no classifiers.
	const surp = providers.find((p) => p.id === "surp");
	assert.equal((surp as any).classify, undefined);
});

test("keyless-capable providers resolve to the sentinel without a key; keyed ones resolve undefined", async () => {
	const providers = await createGatewayProviders(noDiscovery);
	const surp = providers.find((p) => p.id === "surp");
	const bu0y = providers.find((p) => p.id === "bu0y");
	const surpAuth = await surp!.auth.apiKey!.resolve({
		ctx: { env: async () => undefined } as any,
		signal: new AbortController().signal,
	});
	assert.equal(surpAuth?.auth.apiKey, KEYLESS_SENTINEL);
	const bu0yAuth = await bu0y!.auth.apiKey!.resolve({
		ctx: { env: async () => undefined } as any,
		signal: new AbortController().signal,
	});
	assert.equal(bu0yAuth, undefined);
});

test("explicit apiKeys win over everything", async () => {
	const providers = await createGatewayProviders({ ...noDiscovery, apiKeys: { surp: "explicit-key" } });
	const surp = providers.find((p) => p.id === "surp");
	const auth = await surp!.auth.apiKey!.resolve({
		ctx: { env: async () => undefined } as any,
		signal: new AbortController().signal,
	});
	assert.equal(auth?.auth.apiKey, "explicit-key");
});

test("with a wallet configured, streamSimple injects the marked paying fetch", async () => {
	const calls: { options: any }[] = [];
	const providers = await createGatewayProviders({
		...noDiscovery,
		providers: ["surp"],
		helpers: stubHelpers(calls),
		payments: { wallet: new Wallet(TEST_KEY), maxPerRequestUsdc: 0.25 },
	});
	const surp = providers[0];
	const model = surp.getModels().find((m: any) => m.id === "surp/value") as any;
	const stream = surp.streamSimple(model, { messages: [] } as any, {} as any);
	for await (const _ of stream) {
		// drain
	}
	assert.equal(calls.length, 1);
	const fetchUsed = calls[0].options.fetch;
	assert.ok(fetchUsedMarker(fetchUsedMarkerOf(fetchUsed)), "the paying fetch carries the marker");
});

function fetchUsedMarkerOf(fn: unknown): unknown {
	return (fn as Record<symbol, unknown>)?.[X402_FETCH_MARKER];
}
function fetchUsedMarker(marker: unknown): boolean {
	return marker !== undefined && typeof marker === "object";
}

test("without a wallet, streamSimple leaves options.fetch untouched", async () => {
	const calls: { options: any }[] = [];
	const providers = await createGatewayProviders({
		...noDiscovery,
		providers: ["surp"],
		helpers: stubHelpers(calls),
	});
	const surp = providers[0];
	const model = surp.getModels().find((m: any) => m.id === "surp/value") as any;
	const stream = surp.streamSimple(model, { messages: [] } as any, {} as any);
	for await (const _ of stream) {
		// drain
	}
	assert.equal(calls[0].options.fetch, undefined);
});

test("models carry provider and baseUrl (pi-ai detectCompat reads model.baseUrl)", async () => {
	const providers = await createGatewayProviders(noDiscovery);
	for (const provider of providers) {
		for (const model of provider.getAllModels!()) {
			assert.equal((model as any).provider, provider.id, `${provider.id} model ${(model as any).id}`);
			assert.equal(typeof (model as any).baseUrl, "string", `${provider.id} model ${(model as any).id} needs baseUrl`);
		}
	}
});
