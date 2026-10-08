import type { ProviderDescriptor } from "./constants.ts";

/** GPT-5-family models require the OpenAI Responses endpoint. */
export function usesOpenAIResponsesApi(modelId: string): boolean {
	const match = /^gpt-(\d+)(?:[.-]|$)/i.exec(modelId.trim());
	return match !== null && Number(match[1]) >= 5;
}

function parseCost(value: unknown): number {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isFinite(n) ? n * 1_000_000 : 0;
}

function parsePerMillionPrice(value: unknown): number {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isFinite(n) ? n : 0;
}

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Build a pi-ai `thinkingLevelMap` from InferHub's advertised
 * `reasoning_levels`. Levels InferHub does not list are explicitly null so
 * neither pi-ai's clamping nor this extension's effort clamp ever sends an
 * unsupported effort (InferHub rejects nothing today, but only advertised
 * levels are contractual). "off" stays disabled unless listed — InferHub's
 * reasoning models always reason.
 */
function inferhubThinkingLevelMap(levels: unknown): Record<string, string | null> {
	const supported = new Set(
		(Array.isArray(levels) ? levels : []).filter((l): l is string => typeof l === "string"),
	);
	const map: Record<string, string | null> = {};
	for (const level of PI_THINKING_LEVELS) {
		map[level] = supported.has(level) ? level : null;
	}
	return map;
}

/**
 * Clamp a requested thinking level to what the model supports, mirroring
 * pi-ai's `clampThinkingLevel` (nearest supported level, searching upward
 * first). Models without an explicit `thinkingLevelMap` (Surplus catalog
 * entries) pass the level through unchanged, preserving their historical
 * behavior; InferHub models carry a map built from `reasoning_levels`.
 */
export function clampGatewayThinkingLevel(model: any, level: string): string | undefined {
	const map = model?.thinkingLevelMap as Record<string, string | null> | undefined;
	if (!map) return level;
	const available = PI_THINKING_LEVELS.filter((l) => {
		const mapped = map[l];
		if (mapped === null) return false;
		// pi-ai semantics: xhigh/max require an explicit mapping; other levels
		// with no mapping at all are treated as pass-through supported.
		if (l === "xhigh" || l === "max") return mapped !== undefined;
		return true;
	});
	if ((available as string[]).includes(level)) return level;
	const requestedIndex = PI_THINKING_LEVELS.indexOf(level as (typeof PI_THINKING_LEVELS)[number]);
	if (requestedIndex === -1) return available[0];
	for (let i = requestedIndex; i < PI_THINKING_LEVELS.length; i++) {
		const candidate = PI_THINKING_LEVELS[i];
		if ((available as string[]).includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = PI_THINKING_LEVELS[i];
		if ((available as string[]).includes(candidate)) return candidate;
	}
	return available[0];
}

function gatewayCompat(canReasonEffort: boolean) {
	return {
		maxTokensField: "max_tokens",
		supportsDeveloperRole: false,
		supportsStrictMode: false,
		supportsUsageInStreaming: true,
		supportsReasoningEffort: canReasonEffort,
	};
}


/** Read a nested plain object from a catalog record, or undefined. */
function nested(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Map a Surplus Intelligence catalog entry (OpenRouter-style envelope). */
function mapSurplusEntry(model: unknown, descriptor: ProviderDescriptor): any {
	const m = model as Record<string, unknown> | undefined;
	if (!m || typeof m.id !== "string") return undefined;

	const modalities = nested(m.architecture)?.input_modalities;
	const input: ("text" | "image")[] = Array.isArray(modalities)
		? modalities.filter((x: unknown) => x === "text" || x === "image")
		: ["text"];
	if (input.length === 0) input.push("text");

	const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
	const canReason = params.includes("reasoning") || params.includes("include_reasoning");
	const canReasonEffort = params.includes("reasoning_effort");

	const topProvider = nested(m.top_provider);
	const contextWindow = m.context_length ?? topProvider?.context_length ?? 128_000;
	const maxTokens = topProvider?.max_completion_tokens ?? 32_768;

	return {
		id: m.id,
		api: descriptor.api,
		name: typeof m.name === "string" && m.name ? m.name : m.id,
		reasoning: canReason,
		input,
		cost: {
			input: parseCost(nested(m.pricing)?.prompt),
			output: parseCost(nested(m.pricing)?.completion),
			cacheRead: parseCost(nested(m.pricing)?.input_cache_read),
			cacheWrite: 0,
		},
		contextWindow: typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 128_000,
		maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 32_768,
		compat: gatewayCompat(canReasonEffort),
	};
}

/**
 * Map an InferHub catalog entry. InferHub uses its own envelope: comma-
 * separated `modality`, `input_token_limit` / `max_output_tokens`, per-model
 * `reasoning_levels`, and prices in `pricing.min_ask_{in,out}` (dollars).
 */
function mapInferhubEntry(model: unknown, descriptor: ProviderDescriptor): any {
	const m = model as Record<string, unknown> | undefined;
	if (!m || typeof m.id !== "string") return undefined;

	const modality = typeof m.modality === "string" ? m.modality : "text";
	const input = modality
		.split(",")
		.map((part: string) => part.trim())
		.filter((part: string): part is "text" | "image" => part === "text" || part === "image");
	if (input.length === 0) input.push("text");

	const reasoningLevels = Array.isArray(m.reasoning_levels) ? m.reasoning_levels : [];
	const canReason = reasoningLevels.length > 0;

	const contextWindow = m.input_token_limit ?? 128_000;
	const maxTokens = m.max_output_tokens ?? 32_768;

	return {
		id: m.id,
		api: descriptor.api,
		name: typeof m.upstream_label === "string" && m.upstream_label ? m.upstream_label : m.id,
		reasoning: canReason,
		thinkingLevelMap: canReason ? inferhubThinkingLevelMap(reasoningLevels) : undefined,
		input,
		cost: {
			input: parseCost(nested(m.pricing)?.min_ask_in),
			output: parseCost(nested(m.pricing)?.min_ask_out),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 128_000,
		maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 32_768,
		compat: gatewayCompat(canReason),
	};
}

/** Map a catalog entry into a Pi model definition. */
function mapCheaperInferenceEntry(model: unknown, descriptor: ProviderDescriptor): any {
	const m = model as Record<string, unknown> | undefined;
	if (!m || typeof m.id !== "string" || (m.type !== undefined && m.type !== "text")) return undefined;

	const capabilities = nested(m.capabilities) ?? {};
	const pricing = nested(m.pricing) ?? {};
	const input: ("text" | "image")[] = ["text"];
	if (capabilities.vision === true) input.push("image");
	const contextWindow = m.context_length ?? 128_000;
	const maxTokens = m.max_output_tokens ?? 32_768;

	return {
		id: m.id,
		api: descriptor.api,
		name: typeof m.name === "string" && m.name ? m.name : m.id,
		reasoning: capabilities.reasoning === true,
		input,
		cost: {
			input: parsePerMillionPrice(pricing.input_per_million),
			output: parsePerMillionPrice(pricing.output_per_million),
			cacheRead: parsePerMillionPrice(pricing.cache_read_input_per_million),
			cacheWrite: parsePerMillionPrice(pricing.cache_write_input_per_million),
		},
		contextWindow: typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 128_000,
		maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 32_768,
		compat: gatewayCompat(capabilities.reasoning === true),
	};
}

/**
 * Map a Surp combo entry. Surp's `/v1/models` is not OpenAI-shaped: it lists
 * `{ combos: [{ combo, resolved_model, usd_per_1m_tokens, pool_size, ... }] }`
 * (see docs/probe-results.md). The combo id is the model id the caller sends.
 */
function mapSurpEntry(model: unknown, descriptor: ProviderDescriptor): any {
	const m = model as Record<string, unknown> | undefined;
	if (!m || typeof m.combo !== "string" || m.combo.length === 0) return undefined;
	return {
		id: m.combo,
		api: descriptor.api,
		name: typeof m.resolved_model === "string" && m.resolved_model
			? `${m.combo} → ${m.resolved_model}`
			: m.combo,
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: {
			// Live prices are per-request quotes from the 402 challenge; the
			// catalog's indicative rate is kept for display only.
			input: parsePerMillionPrice(m.usd_per_1m_tokens),
			output: parsePerMillionPrice(m.usd_per_1m_tokens),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128_000,
		maxTokens: 32_768,
		compat: gatewayCompat(true),
	};
}

/**
 * Map a Bu0y catalog entry. Bu0y prices in integer microdollars per million
 * tokens (`inputPer1m`/`outputPer1m`), which match Pi's cost units directly.
 */
function mapBu0yEntry(model: unknown, descriptor: ProviderDescriptor): any {
	const m = model as Record<string, unknown> | undefined;
	if (!m || typeof m.id !== "string") return undefined;
	const contextWindow = m.context_length ?? 128_000;
	const maxTokens = nested(m.top_provider)?.max_completion_tokens ?? 32_768;
	return {
		id: m.id,
		api: descriptor.api,
		name: m.id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: {
			input: parsePerMillionPrice(m.inputPer1m),
			output: parsePerMillionPrice(m.outputPer1m),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 128_000,
		maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 32_768,
		compat: gatewayCompat(false),
	};
}

/**
 * Map a Ruvicode catalog entry. OpenAI-shaped with extra pricing fields such
 * as `cache_read_price` (dollars per million tokens, per the live catalog).
 */
function mapRuvicodeEntry(model: unknown, descriptor: ProviderDescriptor): any {
	const m = model as Record<string, unknown> | undefined;
	if (!m || typeof m.id !== "string") return undefined;
	const contextWindow = m.context_length ?? 128_000;
	const maxTokens = m.max_completion_tokens ?? 32_768;
	return {
		id: m.id,
		api: descriptor.api,
		name: typeof m.name === "string" && m.name ? m.name : m.id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: {
			input: parsePerMillionPrice(m.input_price),
			output: parsePerMillionPrice(m.output_price),
			cacheRead: parsePerMillionPrice(m.cache_read_price),
			cacheWrite: 0,
		},
		contextWindow: typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 128_000,
		maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 32_768,
		compat: gatewayCompat(false),
	};
}

/** Map a catalog entry into a Pi model definition. */
export function mapGatewayModel(model: unknown, descriptor: ProviderDescriptor): any {
	if (descriptor.catalog === "inferhub") return mapInferhubEntry(model, descriptor);
	if (descriptor.catalog === "cheaper-inference") return mapCheaperInferenceEntry(model, descriptor);
	if (descriptor.catalog === "surp") return mapSurpEntry(model, descriptor);
	if (descriptor.catalog === "bu0y") return mapBu0yEntry(model, descriptor);
	if (descriptor.catalog === "ruvicode") return mapRuvicodeEntry(model, descriptor);
	return mapSurplusEntry(model, descriptor);
}

function surplusFallbackModels(descriptor: ProviderDescriptor): any[] {
	// Minimal fallback so startup doesn't break if the model catalog can't be
	// fetched. Reasoning flags mirror the advertised supported_parameters.
	return [
		{
			id: "kimi-k2.7-code",
			api: descriptor.api,
			name: "Kimi K2.7 Code",
			reasoning: true,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 262_144,
			maxTokens: 262_144,
			compat: gatewayCompat(true),
		},
		{
			id: "claude-sonnet-5",
			api: descriptor.api,
			name: "Claude Sonnet 5",
			reasoning: true,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			compat: gatewayCompat(true),
		},
		{
			id: "gpt-5.6-luna-pro",
			api: descriptor.api,
			name: "GPT 5.6 Luna Pro",
			reasoning: true,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 1_100_000,
			maxTokens: 131_072,
			compat: gatewayCompat(true),
		},
	];
}

function inferhubFallbackModels(descriptor: ProviderDescriptor): any[] {
	// InferHub model ids are vendor-prefixed; bare ids are rejected at request
	// time. Limits/labels mirror the catalog entries.
	return [
		{
			id: "ag/gemini-3.7-flash-high",
			api: descriptor.api,
			name: "Gemini 3.7 Flash",
			reasoning: true,
			thinkingLevelMap: inferhubThinkingLevelMap(["minimal", "low", "medium", "high"]),
			input: ["text", "image"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 1_000_000,
			maxTokens: 65_536,
			compat: gatewayCompat(true),
		},
		{
			id: "ag/claude-sonnet-4-6",
			api: descriptor.api,
			name: "Claude Sonnet 4.6",
			reasoning: false,
			input: ["text", "image"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			compat: gatewayCompat(false),
		},
	];
}

function cheaperInferenceFallbackModels(descriptor: ProviderDescriptor): any[] {
	return [
		{
			id: "claude-sonnet-4.6",
			api: descriptor.api,
			name: "Claude Sonnet 4.6",
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			compat: gatewayCompat(true),
		},
		{
			id: "gpt-5.6-luna",
			api: descriptor.api,
			name: "GPT-5.6 Luna",
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 1_100_000,
			maxTokens: 128_000,
			compat: gatewayCompat(true),
		},
	];
}

function surpFallbackModels(descriptor: ProviderDescriptor): any[] {
	// The seven documented routes (https://surp.ivc.lol/). `surp/free` works
	// with no key and no wallet; the rest need one or the other.
	const routes: [string, string][] = [
		["surp/free", "Surp Free (no key, no wallet, daily cap)"],
		["surp/value", "Surp Value (smart + cheap)"],
		["surp/jev", "Surp Jev (decision-model routing)"],
		["surp/frontier", "Surp Frontier (best quality)"],
		["surp/fast", "Surp Fast (lowest latency)"],
		["surp/vision", "Surp Vision (images)"],
		["surp/custom", "Surp Custom (tune weights)"],
	];
	return routes.map(([id, name]) => ({
		id,
		api: descriptor.api,
		name,
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0 },
		contextWindow: 128_000,
		maxTokens: 32_768,
		compat: gatewayCompat(true),
	}));
}

function bu0yFallbackModels(descriptor: ProviderDescriptor): any[] {
	// Bu0y slugs are bare catalog ids (no vendor prefix), per its llms.txt.
	return [
		{
			id: "glm4.6",
			api: descriptor.api,
			name: "GLM 4.6",
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 131_072,
			maxTokens: 32_768,
			compat: gatewayCompat(false),
		},
		{
			id: "kimik25",
			api: descriptor.api,
			name: "Kimi K2.5",
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 262_144,
			maxTokens: 32_768,
			compat: gatewayCompat(false),
		},
	];
}

function ruvicodeFallbackModels(descriptor: ProviderDescriptor): any[] {
	return [
		{
			id: "claude-fable-5",
			api: descriptor.api,
			name: "Claude Fable 5",
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			compat: gatewayCompat(false),
		},
		{
			id: "claude-haiku-4.5",
			api: descriptor.api,
			name: "Claude Haiku 4.5",
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
			compat: gatewayCompat(false),
		},
	];
}

export function fallbackModels(descriptor: ProviderDescriptor): any[] {
	if (descriptor.catalog === "inferhub") return inferhubFallbackModels(descriptor);
	if (descriptor.catalog === "cheaper-inference") return cheaperInferenceFallbackModels(descriptor);
	if (descriptor.catalog === "surp") return surpFallbackModels(descriptor);
	if (descriptor.catalog === "bu0y") return bu0yFallbackModels(descriptor);
	if (descriptor.catalog === "ruvicode") return ruvicodeFallbackModels(descriptor);
	return surplusFallbackModels(descriptor);
}

/** Clone Claude models for Pi's native Anthropic Messages adapter. */
export function anthropicClaudeModels(models: any[]): any[] {
	return models
		.filter((model) => /claude-/i.test(`${model.id} ${model.name}`))
		.map((model) => {
			const adaptiveThinking = /claude-(?:opus|sonnet|fable)-(?:4[.-](?:6|7|8)|5(?:[.-]\d+)?)/i.test(model.id);
			const temperatureUnsupported = /claude-opus-(?:4[.-](?:7|8)|5(?:[.-]\d+)?)/i.test(model.id);
			return {
				...model,
				api: "anthropic-messages",
				compat: {
					supportsStrictTools: true,
					...(adaptiveThinking ? { forceAdaptiveThinking: true } : {}),
					...(temperatureUnsupported ? { supportsTemperature: false } : {}),
				},
			};
		});
}

/**
 * Fetch a provider's live catalog. `apiKey` is optional: providers with a
 * public catalog (Surp, Bu0y, Ruvicode — see docs/probe-results.md) are
 * queried without an Authorization header when no key exists. Surp's catalog
 * lists `combos` rather than an OpenAI `data` array.
 */
export async function fetchModels(descriptor: ProviderDescriptor, apiKey?: string): Promise<any[]> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	// URLs come from the static PROVIDERS descriptors, never from request data.
	const response = await fetch(descriptor.modelsUrl, { headers });
	if (!response.ok) {
		throw new Error(`${descriptor.name} /v1/models returned ${response.status}`);
	}
	const payload = (await response.json()) as { data?: unknown[]; combos?: unknown[] } | undefined;
	const entries = payload?.data ?? payload?.combos ?? [];
	const models = entries.map((m) => mapGatewayModel(m, descriptor)).filter((m): m is any => m !== undefined);
	if (models.length === 0) {
		throw new Error(`${descriptor.name} /v1/models returned no models`);
	}
	return models;
}
