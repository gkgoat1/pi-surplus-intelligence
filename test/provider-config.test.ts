import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { INFERHUB, SURPLUS_INTELLIGENCE } from "../src/constants.ts";
import {
	expandEnvTemplate,
	loadProvidersFileConfig,
	resolveProviderCredentials,
} from "../src/provider-config.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryProject(config?: string): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-surplus-provider-config-"));
	directories.push(cwd);
	if (config !== undefined) {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "surplus-intelligence.json"), config);
	}
	return cwd;
}

test("falls back to the provider's environment variable", () => {
	const resolved = resolveProviderCredentials(INFERHUB, undefined, {
		env: { INFERHUB_API_KEY: "env-key" },
	});
	assert.deepEqual(resolved, { ok: true, apiKey: "env-key", source: "environment" });
});

test("config file literal key takes precedence over the environment", () => {
	const resolved = resolveProviderCredentials(INFERHUB, { apiKey: "config-key" }, {
		env: { INFERHUB_API_KEY: "env-key" },
	});
	assert.deepEqual(resolved, { ok: true, apiKey: "config-key", source: "config" });
});

test("expands $VAR and ${VAR} templates in config keys", () => {
	const env = { IH_TOKEN: "templated-key" };
	assert.deepEqual(
		resolveProviderCredentials(INFERHUB, { apiKey: "$IH_TOKEN" }, { env }),
		{ ok: true, apiKey: "templated-key", source: "config" },
	);
	assert.deepEqual(
		resolveProviderCredentials(INFERHUB, { apiKey: "${IH_TOKEN}" }, { env }),
		{ ok: true, apiKey: "templated-key", source: "config" },
	);
});

test("fails closed when a config key references an unset variable", () => {
	const resolved = resolveProviderCredentials(INFERHUB, { apiKey: "$MISSING_VAR" }, { env: {} });
	assert.equal(resolved.ok, false);
	assert.match((resolved as { reason: string }).reason, /unset environment variable/);
});

test("runs !command key sources through the injectable exec", () => {
	const commands: string[] = [];
	const resolved = resolveProviderCredentials(INFERHUB, { apiKey: "!cat key.txt" }, {
		env: {},
		exec: (command) => {
			commands.push(command);
			return "command-key\n";
		},
	});
	assert.deepEqual(resolved, { ok: true, apiKey: "command-key", source: "config" });
	assert.deepEqual(commands, ["cat key.txt"]);
});

test("treats failing or empty key commands as unconfigured, not fatal", () => {
	const failed = resolveProviderCredentials(SURPLUS_INTELLIGENCE, { apiKey: "!exit 1" }, {
		env: {},
		exec: () => {
			throw new Error("exit status 1");
		},
	});
	assert.equal(failed.ok, false);
	assert.match((failed as { reason: string }).reason, /key command failed/);

	const empty = resolveProviderCredentials(SURPLUS_INTELLIGENCE, { apiKey: "!true" }, {
		env: {},
		exec: () => "\n",
	});
	assert.equal(empty.ok, false);
});

test("enabled: false keeps the provider from being configured", () => {
	const resolved = resolveProviderCredentials(INFERHUB, { enabled: false, apiKey: "config-key" }, {
		env: { INFERHUB_API_KEY: "env-key" },
	});
	assert.deepEqual(resolved, { ok: false, reason: "disabled in config" });
});

test("reports the missing-key guidance when nothing is configured", () => {
	const resolved = resolveProviderCredentials(INFERHUB, undefined, { env: {} });
	assert.equal(resolved.ok, false);
	assert.match((resolved as { reason: string }).reason, /INFERHUB_API_KEY/);
	assert.match((resolved as { reason: string }).reason, /providers\.inferhub\.apiKey/);
});

test("expandEnvTemplate supports escapes and embedded templates", () => {
	const env = { KEY: "abc" };
	assert.equal(expandEnvTemplate("$$KEY", env), "$KEY");
	assert.equal(expandEnvTemplate("prefix-${KEY}-suffix", env), "prefix-abc-suffix");
	assert.equal(expandEnvTemplate("$KEY", env), "abc");
	assert.equal(expandEnvTemplate("no dollars here", env), "no dollars here");
	assert.equal(expandEnvTemplate("$UNSET", env), undefined);
});

test("loads the providers section and flags unknown provider ids", () => {
	const cwd = temporaryProject(
		JSON.stringify({
			providers: {
				inferhub: { apiKey: "key" },
				"surpluss-inteligence": { apiKey: "typo" },
			},
		}),
	);
	const { providers, diagnostics } = loadProvidersFileConfig(cwd);
	assert.deepEqual(providers.inferhub, { apiKey: "key", enabled: undefined });
	assert.equal(diagnostics.length, 1);
	assert.match(diagnostics[0], /Unknown provider "surpluss-inteligence"/);
});

test("tolerates a missing or malformed config file without throwing", () => {
	const missing = loadProvidersFileConfig(temporaryProject());
	assert.deepEqual(missing.providers, {});
	assert.deepEqual(missing.diagnostics, []);

	const malformed = loadProvidersFileConfig(temporaryProject("{ not json"));
	assert.deepEqual(malformed.providers, {});
	assert.equal(malformed.diagnostics.length, 1);
	assert.match(malformed.diagnostics[0], /Invalid/);

	const wrongType = loadProvidersFileConfig(temporaryProject(JSON.stringify({ providers: { inferhub: "key" } })));
	assert.deepEqual(wrongType.providers, {});
	assert.match(wrongType.diagnostics[0], /providers\.inferhub.*must be an object/);
});
