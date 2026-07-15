/**
 * Pi extension for Surplus Intelligence.
 *
 * Registers Surplus Intelligence as an OpenAI-compatible chat-completions
 * provider and discovers available models from its /v1/models endpoint. A
 * custom streamSimple wrapper injects `include_reasoning: true` and wires the
 * standard `reasoning_effort` control so models that expose reasoning show a
 * reasoning preview in Pi.
 *
 * Usage:
 *   export SURPLUS_INTELLIGENCE_API_KEY="..."
 *   pi
 *   /model surplus-intelligence/kimi-k2.7-code
 */
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROVIDER_ID = "surplus-intelligence";
const PROVIDER_NAME = "Surplus Intelligence";
const BASE_URL = "https://api.surplusintelligence.ai/v1";
const MODELS_URL = `${BASE_URL}/models`;
const API_KEY_ENV_VAR = "SURPLUS_INTELLIGENCE_API_KEY";
const API = "surplus-openai-completions";

type OpenAICompletionsStream = (
	model: Model<"openai-completions">,
	context: Context,
	options?: any,
) => AssistantMessageEventStream;

async function loadOpenAICompletionsStream(): Promise<OpenAICompletionsStream> {
	// The built-in openai-completions module is ESM-only and pi's jiti
	// extension loader resolves subpath imports via CommonJS, which fails on
	// packages without a "require" export. Load the file directly by locating
	// pi-coding-agent's installation path from the running CLI binary.
	const binPath = realpathSync(process.argv[1] ?? process.execPath);
	const piCodingDir = dirname(fileURLToPath(pathToFileURL(binPath)));
	const candidates = [
		join(
			piCodingDir,
			"../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js",
		),
		join(piCodingDir, "../../pi-ai/dist/api/openai-completions.js"),
	];
	const apiPath = candidates.find((candidate) => existsSync(candidate));
	if (!apiPath) {
		throw new Error(
			"Could not locate the built-in openai-completions module relative to pi-coding-agent.",
		);
	}
	const mod = (await import(pathToFileURL(apiPath).href)) as {
		stream: OpenAICompletionsStream;
	};
	return mod.stream;
}

function parseCost(value: unknown): number {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isFinite(n) ? n * 1_000_000 : 0;
}

function mapSurplusModel(model: unknown): any {
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

function fallbackModels(): any[] {
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
	];
}

async function fetchModels(apiKey: string): Promise<any[]> {
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
	const models = payload?.data?.map(mapSurplusModel).filter((m): m is any => m !== undefined) ?? [];
	if (models.length === 0) {
		throw new Error("Surplus Intelligence /v1/models returned no models");
	}
	return models;
}

function createSurplusStreamSimple(
	openAICompletionsStream: OpenAICompletionsStream,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	return function surplusStreamSimple(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const reasoning = options?.reasoning;
		const reasoningEffort =
			reasoning && reasoning !== "off" && model.reasoning ? reasoning : undefined;

		const originalOnPayload = options?.onPayload;

		return openAICompletionsStream(model as Model<"openai-completions">, context, {
			...options,
			reasoningEffort,
			onPayload(payload) {
				const params = payload as Record<string, any>;
				if (model.reasoning) {
					params.include_reasoning = true;
				}
				if (
					reasoningEffort !== undefined &&
					model.compat?.supportsReasoningEffort !== false &&
					params.reasoning_effort === undefined
				) {
					params.reasoning_effort = reasoningEffort;
				}
				if (originalOnPayload) {
					const next = originalOnPayload(params, model);
					if (next !== undefined) return next;
				}
				return params;
			},
		});
	};
}

export default async function (pi: ExtensionAPI) {
	const [apiKey, openAICompletionsStream] = await Promise.all([
		process.env[API_KEY_ENV_VAR],
		loadOpenAICompletionsStream().catch(() => undefined),
	]);

	let models = fallbackModels();

	if (apiKey) {
		try {
			models = await fetchModels(apiKey);
		} catch {
			// Keep fallback models if discovery fails so startup doesn't break.
		}
	}

	if (!openAICompletionsStream) {
		throw new Error(
			"Failed to load the built-in openai-completions stream for Surplus Intelligence.",
		);
	}

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		apiKey: `$${API_KEY_ENV_VAR}`,
		api: API,
		authHeader: true,
		models,
		streamSimple: createSurplusStreamSimple(openAICompletionsStream),
	});
}