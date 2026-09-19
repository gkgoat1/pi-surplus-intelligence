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

function gatewayCompat(canReasonEffort: boolean) {
	return {
		maxTokensField: "max_tokens",
		supportsDeveloperRole: false,
		supportsStrictMode: false,
		supportsUsageInStreaming: true,
		supportsReasoningEffort: canReasonEffort,
	};
}

/** Map a Surplus Intelligence catalog entry (OpenRouter-style envelope). */
function mapSurplusEntry(model: unknown, descriptor: ProviderDescriptor): any {
	const m = model as Record<string, any> | undefined;
	if (!m || typeof m.id !== "string") return undefined;

	const modalities = m.architecture?.input_modalities;
	const input: ("text" | "image")[] = Array.isArray(modalities)
		? modalities.filter((x: unknown) => x === "text" || x === "image")
		: ["text"];
	if (input.length === 0) input.push("text");

	const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
	const canReason = params.includes("reasoning") || params.includes("include_reasoning");
	const canReasonEffort = params.includes("reasoning_effort");

	const contextWindow = m.context_length ?? m.top_provider?.context_length ?? 128_000;
	const maxTokens = m.top_provider?.max_completion_tokens ?? 32_768;

	return {
		id: m.id,
		api: descriptor.api,
		name: typeof m.name === "string" && m.name ? m.name : m.id,
		reasoning: canReason,
		input,
		cost: {
			input: parseCost(m.pricing?.prompt),
			output: parseCost(m.pricing?.completion),
			cacheRead: parseCost(m.pricing?.input_cache_read),
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
	const m = model as Record<string, any> | undefined;
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
		input,
		cost: {
			input: parseCost(m.pricing?.min_ask_in),
			output: parseCost(m.pricing?.min_ask_out),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 128_000,
		maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 32_768,
		compat: gatewayCompat(canReason),
	};
}

/** Map a catalog entry of either provider into a Pi model definition. */
export function mapGatewayModel(model: unknown, descriptor: ProviderDescriptor): any {
	return descriptor.catalog === "inferhub"
		? mapInferhubEntry(model, descriptor)
		: mapSurplusEntry(model, descriptor);
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

export function fallbackModels(descriptor: ProviderDescriptor): any[] {
	return descriptor.catalog === "inferhub"
		? inferhubFallbackModels(descriptor)
		: surplusFallbackModels(descriptor);
}

export async function fetchModels(descriptor: ProviderDescriptor, apiKey: string): Promise<any[]> {
	const response = await fetch(descriptor.modelsUrl, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
	});
	if (!response.ok) {
		throw new Error(`${descriptor.name} /v1/models returned ${response.status}`);
	}
	const payload = (await response.json()) as { data?: unknown[] } | undefined;
	const models =
		payload?.data?.map((m) => mapGatewayModel(m, descriptor)).filter((m): m is any => m !== undefined) ?? [];
	if (models.length === 0) {
		throw new Error(`${descriptor.name} /v1/models returned no models`);
	}
	return models;
}
