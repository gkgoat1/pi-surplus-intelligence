import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
type ExtensionMode = "tui" | "rpc" | "json" | "print";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "./constants.ts";

const CONFIG_PATH = [".pi", "surplus-intelligence.json"];
const STATUS_KEY = "surplus-intelligence";
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const GLOBAL_STATE_KEY = Symbol.for("pi-surplus-intelligence:preferred-provider-state");

type PreferredProviderConfig = {
	provider: string;
	models?: Record<string, string>;
};

type PreferredProviderSettings = {
	preferredProviders: PreferredProviderConfig[];
};

type RouteHealth = {
	consecutiveFailures: number;
	retryAt: number;
};

type SessionScope = {
	cwd: string;
	config: PreferredProviderSettings;
	modelRegistry: ModelRegistry;
	mode: ExtensionMode;
	ui: ExtensionUIContext;
	trusted: boolean;
};

type GlobalHotswapState = {
	sessions: Map<string, SessionScope>;
	lastSessionId?: string;
	health: Map<string, RouteHealth>;
	reportedDiagnostics: Set<string>;
};

export type PreferredRoute = {
	key: string;
	scopeId: string;
	model: Model<Api>;
	providerName: string;
	modelName: string;
	auth: {
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	};
};

export type ConfigurePreferredProvidersOptions = {
	sessionId: string;
	cwd: string;
	modelRegistry: ModelRegistry;
	mode: ExtensionMode;
	ui: ExtensionUIContext;
	trusted: boolean;
};

function getState(): GlobalHotswapState {
	const host = globalThis as Record<PropertyKey, unknown>;
	const existing = host[GLOBAL_STATE_KEY] as GlobalHotswapState | undefined;
	if (existing) return existing;

	const state: GlobalHotswapState = {
		sessions: new Map(),
		health: new Map(),
		reportedDiagnostics: new Set(),
	};
	host[GLOBAL_STATE_KEY] = state;
	return state;
}

function emptySettings(): PreferredProviderSettings {
	return { preferredProviders: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(value: unknown): PreferredProviderSettings {
	if (!isPlainObject(value)) {
		throw new Error("must contain a JSON object");
	}

	const rawProviders = value.preferredProviders;
	if (rawProviders === undefined) return emptySettings();
	if (!Array.isArray(rawProviders)) {
		throw new Error('"preferredProviders" must be an array');
	}

	const providers: PreferredProviderConfig[] = [];
	const seenProviders = new Set<string>();
	for (const [index, rawProvider] of rawProviders.entries()) {
		if (!isPlainObject(rawProvider)) {
			throw new Error(`"preferredProviders[${index}]" must be an object`);
		}
		if (typeof rawProvider.provider !== "string" || rawProvider.provider.length === 0) {
			throw new Error(`"preferredProviders[${index}].provider" must be a non-empty string`);
		}
		if (seenProviders.has(rawProvider.provider)) {
			throw new Error(`"preferredProviders" contains duplicate provider "${rawProvider.provider}"`);
		}
		seenProviders.add(rawProvider.provider);

		let models: Record<string, string> | undefined;
		if (rawProvider.models !== undefined) {
			if (!isPlainObject(rawProvider.models)) {
				throw new Error(`"preferredProviders[${index}].models" must be an object`);
			}
			models = {};
			for (const [surplusModelId, preferredModelId] of Object.entries(rawProvider.models)) {
				if (typeof preferredModelId !== "string" || preferredModelId.length === 0) {
					throw new Error(
						`"preferredProviders[${index}].models.${surplusModelId}" must be a non-empty string`,
					);
				}
				models[surplusModelId] = preferredModelId;
			}
		}
		providers.push({ provider: rawProvider.provider, models });
	}

	return { preferredProviders: providers };
}

function loadSettings(cwd: string, trusted: boolean): { settings: PreferredProviderSettings; diagnostic?: string } {
	if (!trusted) return { settings: emptySettings() };

	const path = join(cwd, ...CONFIG_PATH);
	try {
		const raw = readFileSync(path, "utf8");
		return { settings: parseSettings(JSON.parse(raw)) };
	} catch (error: any) {
		if (error?.code === "ENOENT") return { settings: emptySettings() };
		const detail = error instanceof Error ? error.message : String(error);
		return {
			settings: emptySettings(),
			diagnostic: `Invalid ${CONFIG_PATH.join("/")}: ${detail}. Surplus will use its normal upstream.`,
		};
	}
}

/**
 * Associate a session with the current project configuration and Pi registry.
 * Route health deliberately remains process-global and is keyed by cwd so an
 * extension reload or a separate agent does not discard active backoff.
 */
export function configurePreferredProviders(
	options: ConfigurePreferredProvidersOptions,
): string | undefined {
	const { settings, diagnostic } = loadSettings(options.cwd, options.trusted);
	const state = getState();
	state.sessions.set(options.sessionId, {
		cwd: options.cwd,
		config: settings,
		modelRegistry: options.modelRegistry,
		mode: options.mode,
		ui: options.ui,
		trusted: options.trusted,
	});
	state.lastSessionId = options.sessionId;

	if (!diagnostic) return undefined;
	const diagnosticKey = `${options.cwd}\0${diagnostic}`;
	if (state.reportedDiagnostics.has(diagnosticKey)) return undefined;
	state.reportedDiagnostics.add(diagnosticKey);
	return diagnostic;
}

export function releasePreferredProviders(sessionId: string): void {
	const state = getState();
	state.sessions.delete(sessionId);
	if (state.lastSessionId === sessionId) {
		state.lastSessionId = state.sessions.keys().next().value;
	}
}

function scopeFor(sessionId?: string): [string, SessionScope] | undefined {
	const state = getState();
	if (sessionId) {
		const scope = state.sessions.get(sessionId);
		if (scope) return [sessionId, scope];
	}
	if (!state.lastSessionId) return undefined;
	const scope = state.sessions.get(state.lastSessionId);
	return scope ? [state.lastSessionId, scope] : undefined;
}

function routeKey(cwd: string, surplusModel: Model<Api>, preferredModel: Model<Api>): string {
	return `${cwd}\0${surplusModel.provider}/${surplusModel.id}\0${preferredModel.provider}/${preferredModel.id}`;
}

function isCoolingDown(key: string, now: number): boolean {
	const retryAt = getState().health.get(key)?.retryAt ?? 0;
	return retryAt > now;
}

function matchingRoutes(
	_scopeId: string,
	scope: SessionScope,
	surplusModel: Model<Api>,
	now: number,
): Array<{ key: string; model: Model<Api>; providerName: string; modelName: string }> {
	if (surplusModel.provider !== PROVIDER_ID) return [];

	const routes: Array<{ key: string; model: Model<Api>; providerName: string; modelName: string }> = [];
	for (const entry of scope.config.preferredProviders) {
		const modelId = entry.models?.[surplusModel.id] ?? surplusModel.id;
		const model = scope.modelRegistry.find(entry.provider, modelId);
		if (
			!model ||
			model.provider === PROVIDER_ID ||
			!scope.modelRegistry.hasConfiguredAuth(model)
		) {
			continue;
		}

		const key = routeKey(scope.cwd, surplusModel, model);
		if (isCoolingDown(key, now)) continue;
		routes.push({
			key,
			model,
			providerName: scope.modelRegistry.getProviderDisplayName(model.provider),
			modelName: model.name,
		});
	}
	return routes;
}

/** Resolve a healthy, authenticated upstream without changing Pi's selected model. */
export async function selectPreferredRoute(
	surplusModel: Model<Api>,
	sessionId?: string,
	now = Date.now(),
): Promise<PreferredRoute | undefined> {
	let selectedScope = scopeFor(sessionId);
	if (!selectedScope && sessionId) {
		const state = getState();
		const template = state.lastSessionId ? state.sessions.get(state.lastSessionId) : undefined;
		if (template) {
			const loaded = loadSettings(template.cwd, template.trusted);
			const scope: SessionScope = { ...template, config: loaded.settings };
			state.sessions.set(sessionId, scope);
			selectedScope = [sessionId, scope];
		}
	}
	if (!selectedScope) return undefined;
	const [scopeId, scope] = selectedScope;

	for (const candidate of matchingRoutes(scopeId, scope, surplusModel, now)) {
		const auth = await scope.modelRegistry.getApiKeyAndHeaders(candidate.model);
		if (!auth.ok) continue;
		return {
			key: candidate.key,
			scopeId,
			model: candidate.model,
			auth,
			providerName: candidate.providerName,
			modelName: candidate.modelName,
		};
	}
	return undefined;
}

/** Execute a preferred model through Pi's runtime without changing Pi's active model. */
export function streamPreferredRoute(
	route: PreferredRoute,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const selectedScope = scopeFor(route.scopeId);
	// ModelRegistry is a public facade over Pi's ModelRuntime. The facade does
	// not expose streaming, so use its stable runtime instance to dispatch the
	// already-resolved preferred model without touching Pi's active selection.
	const runtime = (selectedScope?.[1].modelRegistry as any)?.runtime as
		| {
				streamSimple(
					model: Model<Api>,
					context: Context,
					options?: SimpleStreamOptions,
				): AssistantMessageEventStream;
		  }
		| undefined;
	if (!runtime?.streamSimple) {
		throw new Error("Pi model runtime is unavailable for preferred-provider routing");
	}
	return runtime.streamSimple(route.model, context, options);
}

export function recordPreferredRouteSuccess(route: PreferredRoute): void {
	getState().health.delete(route.key);
}

export function recordPreferredRouteFailure(
	route: PreferredRoute,
	now = Date.now(),
	random = Math.random,
): RouteHealth {
	const state = getState();
	const previous = state.health.get(route.key);
	const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
	const ceiling = Math.min(INITIAL_BACKOFF_MS * 2 ** (consecutiveFailures - 1), MAX_BACKOFF_MS);
	const health = {
		consecutiveFailures,
		retryAt: now + Math.floor(random() * ceiling),
	};
	state.health.set(route.key, health);
	return health;
}

function formatDelay(ms: number): string {
	const seconds = Math.max(1, Math.ceil(ms / 1_000));
	return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`;
}

/** Update only interactive status UI; print, JSON, and RPC output remain unchanged. */
export function updatePreferredProviderStatus(
	model: Model<Api> | undefined,
	sessionId?: string,
	now = Date.now(),
): void {
	const selectedScope = scopeFor(sessionId);
	if (!selectedScope) return;
	const [, scope] = selectedScope;
	if (scope.mode !== "tui" || model?.provider !== PROVIDER_ID) {
		scope.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	if (scope.config.preferredProviders.length === 0) {
		scope.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const healthy = matchingRoutes("", scope, model, now)[0];
	if (healthy) {
		scope.ui.setStatus(STATUS_KEY, `Surplus fallback: ${healthy.providerName} ${healthy.modelName}`);
		return;
	}

	let earliestRetryAt: number | undefined;
	for (const entry of scope.config.preferredProviders) {
		const modelId = entry.models?.[model.id] ?? model.id;
		const preferred = scope.modelRegistry.find(entry.provider, modelId);
		if (!preferred) continue;
		const retryAt = getState().health.get(routeKey(scope.cwd, model, preferred))?.retryAt;
		if (retryAt && retryAt > now && (!earliestRetryAt || retryAt < earliestRetryAt)) {
			earliestRetryAt = retryAt;
		}
	}
	const text = earliestRetryAt
		? `Surplus fallback: preferred route retrying in ${formatDelay(earliestRetryAt - now)}`
		: "Surplus upstream";
	scope.ui.setStatus(STATUS_KEY, text);
}

export function setPreferredRouteStatus(route: PreferredRoute | undefined, surplusModel: Model<Api>): void {
	if (!route) {
		updatePreferredProviderStatus(surplusModel);
		return;
	}
	const selectedScope = scopeFor(route.scopeId);
	if (!selectedScope) return;
	const [, scope] = selectedScope;
	if (scope.mode !== "tui") return;
	// Pi's status UI does not have a dedicated per-stream channel; this is a
	// best-effort indication for the foreground session only.
	scope.ui.setStatus(STATUS_KEY, `Surplus fallback: ${route.providerName} ${route.modelName}`);
}

export function clearPreferredProviderStatus(sessionId?: string): void {
	const selectedScope = scopeFor(sessionId);
	if (selectedScope?.[1].mode === "tui") {
		selectedScope[1].ui.setStatus(STATUS_KEY, undefined);
	}
}
