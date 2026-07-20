import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import {
	configurePreferredProviders,
	recordPreferredRouteFailure,
	recordPreferredRouteSuccess,
	selectPreferredRoute,
} from "../src/preferred-providers.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryProject(config?: unknown): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-surplus-preferred-"));
	directories.push(cwd);
	if (config !== undefined) {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "surplus-intelligence.json"), JSON.stringify(config));
	}
	return cwd;
}

function model(provider: string, id: string): Model<any> {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	};
}

function registry(models: Model<any>[]) {
	return {
		find(provider: string, id: string) {
			return models.find((candidate) => candidate.provider === provider && candidate.id === id);
		},
		hasConfiguredAuth(candidate: Model<any>) {
			return candidate.provider !== "unconfigured";
		},
		async getApiKeyAndHeaders() {
			return { ok: true as const, apiKey: "test-key" };
		},
		getProviderDisplayName(provider: string) {
			return provider;
		},
		getRegisteredProviderConfig() {
			return undefined;
		},
	} as any;
}

function configure(sessionId: string, cwd: string, models: Model<any>[]) {
	configurePreferredProviders({
		sessionId,
		cwd,
		modelRegistry: registry(models),
		mode: "print",
		ui: { setStatus() {} } as any,
		trusted: true,
	});
}

test("uses the first configured healthy preferred route", async () => {
	const cwd = temporaryProject({
		preferredProviders: [
			{ provider: "first", models: { "kimi-k2.7-code": "first-kimi" } },
			{ provider: "second" },
		],
	});
	const surplus = model("surplus-intelligence", "kimi-k2.7-code");
	configure("ordered", cwd, [model("first", "first-kimi"), model("second", "kimi-k2.7-code")]);

	const route = await selectPreferredRoute(surplus, "ordered");
	assert.equal(route?.model.provider, "first");
	assert.equal(route?.model.id, "first-kimi");
});

test("backs off a failed route and advances to the next preferred provider", async () => {
	const cwd = temporaryProject({ preferredProviders: [{ provider: "first" }, { provider: "second" }] });
	const surplus = model("surplus-intelligence", "kimi-k2.7-code");
	configure("fallback", cwd, [model("first", surplus.id), model("second", surplus.id)]);

	const first = await selectPreferredRoute(surplus, "fallback", 100);
	assert.ok(first);
	recordPreferredRouteFailure(first, 100, () => 1);

	const second = await selectPreferredRoute(surplus, "fallback", 101);
	assert.equal(second?.model.provider, "second");
	recordPreferredRouteSuccess(second!);
});

test("missing configuration leaves Surplus unchanged", async () => {
	const cwd = temporaryProject();
	const surplus = model("surplus-intelligence", "kimi-k2.7-code");
	configure("no-config", cwd, [model("first", surplus.id)]);
	assert.equal(await selectPreferredRoute(surplus, "no-config"), undefined);
});