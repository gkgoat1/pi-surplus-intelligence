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
		reasoning: m.reasoning ? true : false,
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