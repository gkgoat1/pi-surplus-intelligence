/**
 * Pi extension for Surplus Intelligence.
 *
 * Registers Surplus Intelligence as an OpenAI-compatible chat-completions
 * provider and discovers available models from its /v1/models endpoint. A
 * custom streamSimple wrapper injects `include_reasoning: true`, maps Pi's
 * thinking level to `reasoning_effort`, and falls back to token-count evidence
 * when a model reasons without exposing reasoning text.
 *
 * Usage:
 *   export SURPLUS_INTELLIGENCE_API_KEY="..."
 *   pi
 *   /model surplus-intelligence/kimi-k2.7-code
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { API_KEY_ENV_VAR, PROVIDER_ID, PROVIDER_NAME, BASE_URL, API } from "./src/constants.ts";
import { fetchModels, fallbackModels } from "./src/models.ts";
import { loadStreamHelpers } from "./src/loader.ts";
import { createSurplusStreamSimple } from "./src/stream.ts";

export default async function (pi: ExtensionAPI) {
	const [apiKey, helpers] = await Promise.all([
		process.env[API_KEY_ENV_VAR],
		loadStreamHelpers().catch(() => undefined),
	]);

	let models = fallbackModels();

	if (apiKey) {
		try {
			models = await fetchModels(apiKey);
		} catch {
			// Keep fallback models if discovery fails so startup doesn't break.
		}
	}

	if (!helpers) {
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
		streamSimple: createSurplusStreamSimple(helpers),
	});
}