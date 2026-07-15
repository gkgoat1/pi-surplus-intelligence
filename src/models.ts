import { API, MODELS_URL } from "./constants.ts";

function parseCost(value: unknown): number {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isFinite(n) ? n * 1_000_000 : 0;
}

export function mapSurplusModel(model: unknown): any {
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
		api: API,
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
		compat: {
			maxTokensField: "max_tokens",
			supportsDeveloperRole: false,
			supportsStrictMode: false,
			supportsUsageInStreaming: true,
			supportsReasoningEffort: canReasonEffort,
		},
	};
}

export function applyProOverrides(models: any[]): any[] {
	const ids = new Set(models.map((m) => m.id));
	const overridden = new Set<string>();
	for (const m of models) {
		if (m.id.endsWith("-pro")) {
			const baseId = m.id.slice(0, -4);
			if (ids.has(baseId)) {
				overridden.add(baseId);
			}
		}
	}
	return models.filter((m) => !overridden.has(m.id));
}

export function fallbackModels(): any[] {
	// Minimal fallback so startup doesn't break if the model catalog can't be
	// fetched. Reasoning flags mirror the advertised supported_parameters.
	return [
		{
			id: "kimi-k2.7-code",
			api: API,
			name: "Kimi K2.7 Code",
			reasoning: true,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 262_144,
			maxTokens: 262_144,
			compat: {
				maxTokensField: "max_tokens",
				supportsDeveloperRole: false,
				supportsStrictMode: false,
				supportsUsageInStreaming: true,
				supportsReasoningEffort: true,
			},
		},
		{
			id: "claude-sonnet-5",
			api: API,
			name: "Claude Sonnet 5",
			reasoning: true,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			compat: {
				maxTokensField: "max_tokens",
				supportsDeveloperRole: false,
				supportsStrictMode: false,
				supportsUsageInStreaming: true,
				supportsReasoningEffort: true,
			},
		},
		{
			id: "gpt-5.6-luna-pro",
			api: API,
			name: "GPT 5.6 Luna Pro",
			reasoning: true,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0 },
			contextWindow: 1_100_000,
			maxTokens: 131_072,
			compat: {
				maxTokensField: "max_tokens",
				supportsDeveloperRole: false,
				supportsStrictMode: false,
				supportsUsageInStreaming: true,
				supportsReasoningEffort: true,
			},
		},
	];
}

export async function fetchModels(apiKey: string): Promise<any[]> {
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
	const models = applyProOverrides(
		payload?.data?.map(mapSurplusModel).filter((m): m is any => m !== undefined) ?? [],
	);
	if (models.length === 0) {
		throw new Error("Surplus Intelligence /v1/models returned no models");
	}
	return models;
}