import assert from "node:assert/strict";
import { test } from "node:test";
import { BU0Y, PROVIDERS, SURPLUS_INTELLIGENCE } from "../src/constants.ts";
import { fallbackModels, fetchModels } from "../src/models.ts";

test("all six providers are registered with unique ids, names, and env vars", () => {
	const ids = PROVIDERS.map((d) => d.id);
	assert.deepEqual([...ids].sort(), [
		"bu0y",
		"cheaper-inference",
		"inferhub",
		"ruvicode",
		"surp",
		"surplus-intelligence",
	]);
	assert.equal(new Set(ids).size, PROVIDERS.length);
	for (const descriptor of PROVIDERS) {
		assert.ok(descriptor.name.length > 0, descriptor.id);
		assert.match(descriptor.apiKeyEnvVar, /^[A-Z0-9_]+$/, descriptor.id);
	}
});

test("fetchModels without a key sends no Authorization header", async () => {
	let sawAuth: string | null = "unset";
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		sawAuth = new Headers(init?.headers).get("authorization");
		return new Response(
			JSON.stringify({ data: [{ id: "glm4.6", inputPer1m: 100, outputPer1m: 200 }] }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;
	try {
		const models = await fetchModels(BU0Y, undefined);
		assert.equal(sawAuth, null);
		assert.deepEqual(models.map((m: any) => m.id), ["glm4.6"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("fetchModels with a key sends the Bearer header (keyed providers unchanged)", async () => {
	let sawAuth: string | null = null;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		sawAuth = new Headers(init?.headers).get("authorization");
		return new Response(JSON.stringify({ data: [] }), { status: 200 });
	}) as typeof fetch;
	try {
		await assert.rejects(fetchModels(SURPLUS_INTELLIGENCE, "test-key"), /returned no models/);
		assert.equal(sawAuth, "Bearer test-key");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Surp's combos catalog feeds model discovery", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				combos: [{ combo: "surp/value", resolved_model: "jev-1.13", usd_per_1m_tokens: 0.000414 }],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		)) as typeof fetch;
	try {
		const { SURP } = await import("../src/constants.ts");
		const models = await fetchModels(SURP, undefined);
		assert.deepEqual(models.map((m: any) => m.id), ["surp/value"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a failed catalog fetch leaves the fallback models usable", () => {
	// The registration loop swallows discovery failures; the fallback must be
	// non-empty for every provider so startup never breaks.
	for (const descriptor of PROVIDERS) {
		assert.ok(fallbackModels(descriptor).length > 0, descriptor.id);
	}
});
