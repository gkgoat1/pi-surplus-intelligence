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

// pi-blackhole loads its consolidation agents through a separate jiti module
// graph. Its fallback `streamSimple` registry therefore does not know about
// Pi providers registered by extensions. pi-blackhole intentionally exposes
// this process-wide bridge for those providers; seed it ourselves so the
// result is independent of extension load order.
const BLACKHOLE_PROVIDER_STREAMS_KEY = Symbol.for("pi-blackhole:provider-streams");

function registerBlackholeStreamBridge(api: string, streamSimple: Function): void {
	const host = globalThis as any;
	const streams: Map<string, Function> = host[BLACKHOLE_PROVIDER_STREAMS_KEY] ?? new Map();
	streams.set(api, streamSimple);
	host[BLACKHOLE_PROVIDER_STREAMS_KEY] = streams;
}

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

	const streamSimple = createSurplusStreamSimple(helpers);

	// Register before calling Pi so pi-blackhole can use the custom stream from
	// its isolated agent runtime even when it initialized before or after us.
	registerBlackholeStreamBridge(API, streamSimple);

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		apiKey: `$${API_KEY_ENV_VAR}`,
		api: API,
		authHeader: true,
		models,
		streamSimple,
	});
}