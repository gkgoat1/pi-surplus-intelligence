import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS, PROVIDER_BY_ID, type ProviderDescriptor } from "./constants.ts";

/**
 * Project-local extension configuration. This module owns the `providers`
 * section (per-provider credentials and enablement); `preferred-providers.ts`
 * owns the routing/fallback sections of the same file.
 */
export const CONFIG_PATH = [".pi", "surplus-intelligence.json"];

export type ProviderFileConfig = {
	/**
	 * API key as a literal string, a `$VAR` / `${VAR}` environment template
	 * (Pi config-value syntax), or a `!command` whose stdout is the key.
	 */
	apiKey?: string;
	/** Set to false to keep the provider from being registered at all. */
	enabled?: boolean;
};

export type ProvidersFileConfig = Record<string, ProviderFileConfig>;

export type ResolvedCredentials =
	| { ok: true; apiKey: string; source: "config" | "environment" }
	| { ok: false; reason: string };

export type ExecCommand = (command: string) => string;

export type ResolveCredentialsDeps = {
	env?: Record<string, string | undefined>;
	exec?: ExecCommand;
};

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const COMMAND_TIMEOUT_MS = 5_000;

function defaultExec(command: string): string {
	const shell = process.env.SHELL || "/bin/sh";
	return execFileSync(shell, ["-c", command], {
		encoding: "utf8",
		timeout: COMMAND_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/**
 * Expand `$VAR`/`${VAR}` references against `env` (Pi's config-value template
 * semantics; `$$` and `$!` are escapes). Returns undefined when any
 * referenced variable is unset or empty.
 */
export function expandEnvTemplate(
	value: string,
	env: Record<string, string | undefined>,
): string | undefined {
	let resolved = "";
	let index = 0;
	while (index < value.length) {
		const dollarIndex = value.indexOf("$", index);
		if (dollarIndex < 0) {
			resolved += value.slice(index);
			break;
		}
		resolved += value.slice(index, dollarIndex);
		const nextChar = value[dollarIndex + 1];
		if (nextChar === "$" || nextChar === "!") {
			resolved += nextChar;
			index = dollarIndex + 2;
			continue;
		}
		if (nextChar === "{") {
			const endIndex = value.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				resolved += "$";
				index = dollarIndex + 1;
				continue;
			}
			const name = value.slice(dollarIndex + 2, endIndex);
			if (!ENV_VAR_NAME_RE.test(name)) {
				resolved += value.slice(dollarIndex, endIndex + 1);
				index = endIndex + 1;
				continue;
			}
			const envValue = env[name];
			if (envValue === undefined || envValue === "") return undefined;
			resolved += envValue;
			index = endIndex + 1;
			continue;
		}
		const match = ENV_VAR_NAME_PREFIX_RE.exec(value.slice(dollarIndex + 1));
		if (match) {
			const envValue = env[match[0]];
			if (envValue === undefined || envValue === "") return undefined;
			resolved += envValue;
			index = dollarIndex + 1 + match[0].length;
			continue;
		}
		resolved += "$";
		index = dollarIndex + 1;
	}
	return resolved;
}

/**
 * Resolve a provider's API key. Precedence: the project config file first
 * (literal, `$VAR` template, or `!command`), then the provider's environment
 * variable. Resolution failures never throw; the provider is simply left
 * unconfigured so the other providers still work.
 */
export function resolveProviderCredentials(
	descriptor: ProviderDescriptor,
	fileConfig: ProviderFileConfig | undefined,
	deps: ResolveCredentialsDeps = {},
): ResolvedCredentials {
	const env = deps.env ?? process.env;
	if (fileConfig?.enabled === false) {
		return { ok: false, reason: "disabled in config" };
	}

	const configured = fileConfig?.apiKey;
	if (typeof configured === "string" && configured.trim().length > 0) {
		if (configured.startsWith("!")) {
			try {
				const apiKey = (deps.exec ?? defaultExec)(configured.slice(1)).trim();
				if (apiKey.length === 0) {
					return { ok: false, reason: "key command produced no output" };
				}
				return { ok: true, apiKey, source: "config" };
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return { ok: false, reason: `key command failed: ${detail}` };
			}
		}
		const expanded = expandEnvTemplate(configured, env);
		if (expanded === undefined) {
			return { ok: false, reason: "config apiKey references an unset environment variable" };
		}
		if (expanded.trim().length === 0) {
			return { ok: false, reason: "config apiKey resolved to an empty value" };
		}
		return { ok: true, apiKey: expanded, source: "config" };
	}

	const fromEnv = env[descriptor.apiKeyEnvVar];
	if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
		return { ok: true, apiKey: fromEnv, source: "environment" };
	}
	return {
		ok: false,
		reason: `no API key (set ${descriptor.apiKeyEnvVar} or providers.${descriptor.id}.apiKey in ${CONFIG_PATH.join("/")})`,
	};
}

function parseProviderEntry(value: unknown, path: string): ProviderFileConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`"${path}" must be an object`);
	}
	const entry = value as Record<string, unknown>;
	if (entry.apiKey !== undefined && typeof entry.apiKey !== "string") {
		throw new Error(`"${path}.apiKey" must be a string`);
	}
	if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
		throw new Error(`"${path}.enabled" must be a boolean`);
	}
	return { apiKey: entry.apiKey, enabled: entry.enabled };
}

/**
 * Read the `providers` section of the project config. Missing file or
 * section yields an empty config; malformed content yields a diagnostic for
 * startup notification instead of throwing. Unknown provider ids are
 * reported (typo guard) but otherwise ignored.
 */
export function loadProvidersFileConfig(cwd: string): {
	providers: ProvidersFileConfig;
	diagnostics: string[];
} {
	const path = join(cwd, ...CONFIG_PATH);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return { providers: {}, diagnostics: [] };
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			providers: {},
			diagnostics: [`Invalid ${CONFIG_PATH.join("/")}: ${detail}. Config-file provider keys were ignored.`],
		};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			providers: {},
			diagnostics: [`Invalid ${CONFIG_PATH.join("/")}: must contain a JSON object. Config-file provider keys were ignored.`],
		};
	}

	const rawProviders = (parsed as Record<string, unknown>).providers;
	if (rawProviders === undefined) return { providers: {}, diagnostics: [] };
	try {
		if (typeof rawProviders !== "object" || rawProviders === null || Array.isArray(rawProviders)) {
			throw new Error('"providers" must be an object');
		}
		const providers: ProvidersFileConfig = {};
		const diagnostics: string[] = [];
		for (const [id, entry] of Object.entries(rawProviders)) {
			providers[id] = parseProviderEntry(entry, `providers.${id}`);
			if (!PROVIDER_BY_ID.has(id)) {
				diagnostics.push(
					`Unknown provider "${id}" in ${CONFIG_PATH.join("/")}; expected one of: ${PROVIDERS.map((d) => d.id).join(", ")}.`,
				);
			}
		}
		return { providers, diagnostics };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			providers: {},
			diagnostics: [`Invalid ${CONFIG_PATH.join("/")}: ${detail}. Config-file provider keys were ignored.`],
		};
	}
}
