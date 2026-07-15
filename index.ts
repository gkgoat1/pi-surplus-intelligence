/**
 * Pi extension for Surplus Intelligence.
 *
 * Registers Surplus Intelligence as an OpenAI-compatible provider and discovers
 * available models from its /v1/models endpoint. Falls back to a small curated
 * list if fetching fails or no SURPLUS_INTELLIGENCE_API_KEY is configured.
 *
 * Usage:
 *   export SURPLUS_INTELLIGENCE_API_KEY="..."
 *   pi
 *   /model surplus-intelligence/kimi-k2.7-code
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "surplus-intelligence";
const PROVIDER_NAME = "Surplus Intelligence";
const BASE_URL = "https://api.surplusintelligence.ai/v1";
const MODELS_URL = `${BASE_URL}/models`;
const API_KEY_ENV_VAR = "SURPLUS_INTELLIGENCE_API_KEY";

type ModelConfig = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat?: {
		maxTokensField?: "max_completion_tokens" | "max_tokens";
		supportsDeveloperRole?: boolean;
		supportsStrictMode?: boolean;
		supportsUsageInStreaming?: boolean;
	};
};

function parseCost(value: unknown): number {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isFinite(n) ? n * 1_000_000 : 0;
}

function mapSurplusModel(model: unknown): ModelConfig | undefined {
	const m = model as Record<string, any> | undefined;
	if (!m || typeof m.id !== "string") return undefined;

	const modalities = m.architecture?.input_modalities;
	const input: ("text" | "image")[] = Array.isArray(modalities)
		? modalities.filter((x: unknown) => x === "text" || x === "image")
		: ["text"];
	if (input.length === 0) input.push("text");

	const contextWindow = m.context_length ?? m.top_provider?.context_length ?? 128_000;
	const maxTokens = m.top_provider?.max_completion_tokens ?? 32_768;

	return {
		id: m.id,
		name: typeof m.name === "string" && m.name ? m.name : m.id,
		reasoning: false,
		input,
		cost: {
			input: parseCost(m.pricing?.prompt),
			output: parseCost(m.pricing?.completion),
			cacheRead: parseCost(m.pricing?.input_cache_read),
			cacheWrite: 0,
		},
		contextWindow: typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 128_000,
		maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 32_768,
		compat: {
			maxTokensField: "max_tokens",
			supportsDeveloperRole: false,
			supportsStrictMode: false,
			supportsUsageInStreaming: true,
		},
	};
}

function fallbackModels(): ModelConfig[] {
	return [
		{
			id: "kimi-k2.7-code",
			name: "Kimi K2.7 Code",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.68, output: 3.41, cacheRead: 0.144, cacheWrite: 0 },
			contextWindow: 256_000,
			maxTokens: 32_768,
			compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false, supportsStrictMode: false, supportsUsageInStreaming: true },
		},
		{
			id: "kimi-k2.5",
			name: "Kimi K2.5",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.56, output: 3.5, cacheRead: 0.11, cacheWrite: 0 },
			contextWindow: 256_000,
			maxTokens: 32_768,
			compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false, supportsStrictMode: false, supportsUsageInStreaming: true },
		},
		{
			id: "aion-labs.aion-2-0",
			name: "Aion 2.0",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 32_768,
			compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false, supportsStrictMode: false, supportsUsageInStreaming: true },
		},
		{
			id: "claude-sonnet-4",
			name: "Claude Sonnet 4",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200_000,
			maxTokens: 64_000,
			compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false, supportsStrictMode: false, supportsUsageInStreaming: true },
		},
		{
			id: "openai/gpt-4.1",
			name: "GPT-4.1",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 1_047_576,
			maxTokens: 32_768,
			compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false, supportsStrictMode: false, supportsUsageInStreaming: true },
		},
		{
			id: "openai/gpt-4.1-mini",
			name: "GPT-4.1 Mini",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 1_047_576,
			maxTokens: 32_768,
			compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false, supportsStrictMode: false, supportsUsageInStreaming: true },
		},
	];
}

async function fetchModels(apiKey: string): Promise<ModelConfig[]> {
	const response = await fetch(MODELS_URL, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
	});
	if (!response.ok) {
		throw new Error(`Surplus Intelligence /v1/models returned ${response.status}`);
	}
	const payload = (await response.json()) as { data?: unknown[] } | undefined;
	const models = payload?.data?.map(mapSurplusModel).filter((m): m is ModelConfig => m !== undefined) ?? [];
	if (models.length === 0) {
		throw new Error("Surplus Intelligence /v1/models returned no models");
	}
	return models;
}

export default async function (pi: ExtensionAPI) {
	const apiKey = process.env[API_KEY_ENV_VAR];
	let models = fallbackModels();

	if (apiKey) {
		try {
			models = await fetchModels(apiKey);
		} catch {
			// Keep fallback models if discovery fails so startup doesn't break.
		}
	}

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		apiKey: `$${API_KEY_ENV_VAR}`,
		api: "openai-completions",
		authHeader: true,
		models,
	});
}