/**
 * Pi extension for Surplus Intelligence.
 *
 * Registers Surplus Intelligence as an OpenAI-compatible provider and discovers
 * available models from its /v1/models endpoint. GPT-5-and-later requests use
 * the Responses API; earlier models use chat completions. A custom streamSimple
 * wrapper injects reasoning settings and falls back to token-count evidence
 * when a model reasons without exposing reasoning text.
 *
 * Usage:
 *   export SURPLUS_INTELLIGENCE_API_KEY="..."
 *   pi
 *   /model surplus-intelligence/kimi-k2.7-code
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROVIDERS } from "./src/constants.ts";
import { fetchModels, fallbackModels } from "./src/models.ts";
import { loadProvidersFileConfig, resolveProviderCredentials } from "./src/provider-config.ts";
import { loadStreamHelpers } from "./src/loader.ts";
import {
	clearPreferredProviderStatus,
	configurePreferredProviders,
	releasePreferredProviders,
	updatePreferredProviderStatus,
} from "./src/preferred-providers.ts";
import { configureFingerprint, releaseFingerprint } from "./src/fingerprint.ts";
import { createGatewayStreamSimple } from "./src/stream.ts";
import {
	configureThinkingCompression,
	releaseThinkingCompression,
} from "./src/thinking-compression.ts";

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

function notifyWithFlagMetadata(ui: { notify(message: string, type?: "info" | "warning" | "error"): void }, message: string, category: string): void {
	const helper = (globalThis as Record<symbol, unknown>)[Symbol.for("gkqa-flag-sink:with-notification-metadata")];
	if (typeof helper === "function") {
		(helper as (meta: { source: string; category: string }, callback: () => void) => void)(
			{ source: "pi-surplus-intelligence", category },
			() => ui.notify(message, "warning"),
		);
		return;
	}
	ui.notify(message, "warning");
}

export default async function (pi: ExtensionAPI) {
	const helpers = await loadStreamHelpers().catch(() => undefined);
	if (!helpers) {
		throw new Error(
			"Failed to load the built-in openai-completions stream for model providers.",
		);
	}

	// The extension entry runs before session_start, so the process cwd is the
	// best available project root. Loading the extension already implies the
	// project code is trusted to execute, so config-file keys (including
	// !command sources) resolve here.
	const { providers: fileConfig, diagnostics } = loadProvidersFileConfig(process.cwd());
	for (const diagnostic of diagnostics) {
		console.error(`pi-surplus-intelligence: ${diagnostic}`);
	}

	const streamSimple = createGatewayStreamSimple(helpers);

	for (const descriptor of PROVIDERS) {
		if (fileConfig[descriptor.id]?.enabled === false) continue;
		const credentials = resolveProviderCredentials(descriptor, fileConfig[descriptor.id]);

		let models = fallbackModels(descriptor);
		if (credentials.ok) {
			try {
				models = await fetchModels(descriptor, credentials.apiKey);
			} catch {
				// Keep fallback models if discovery fails so startup doesn't break.
			}
		}

		// Register before calling Pi so pi-blackhole can use the custom stream from
		// its isolated agent runtime even when it initialized before or after us.
		registerBlackholeStreamBridge(descriptor.api, streamSimple);

		// Keep the $VAR template for environment-sourced keys so Pi's auth UI
		// reports the environment source and key rotation works without a
		// restart. Config-sourced keys (including templates and commands) are
		// passed as resolved literals.
		const envTemplate = `$${descriptor.apiKeyEnvVar}`;
		const fileKey = fileConfig[descriptor.id]?.apiKey;
		const apiKey =
			typeof fileKey === "string" && fileKey.trim().length > 0 && fileKey !== envTemplate
				? credentials.ok && credentials.source === "config"
					? credentials.apiKey
					: envTemplate
				: envTemplate;

		pi.registerProvider(descriptor.id, {
			name: descriptor.name,
			baseUrl: descriptor.baseUrl,
			apiKey,
			api: descriptor.api,
			authHeader: true,
			models,
			streamSimple,
		});
	}

	pi.on("session_start", (event, ctx) => {
		const [preferredDiagnostic, compressionDiagnostic] = [
			configurePreferredProviders({
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				modelRegistry: ctx.modelRegistry,
				mode: ctx.mode,
				ui: ctx.ui,
				trusted: ctx.isProjectTrusted(),
			}),
			configureThinkingCompression({
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				modelRegistry: ctx.modelRegistry,
				mode: ctx.mode,
				ui: ctx.ui,
				trusted: ctx.isProjectTrusted(),
			}),
		];
		for (const diagnostic of [preferredDiagnostic, compressionDiagnostic]) {
			if (diagnostic) notifyWithFlagMetadata(ctx.ui, diagnostic, "configuration");
		}
		updatePreferredProviderStatus(ctx.model, ctx.sessionManager.getSessionId());
		// Fingerprinting runs by default (no config needed); it only needs the
		// session's UI context to surface mismatch warnings.
		configureFingerprint({
			sessionId: ctx.sessionManager.getSessionId(),
			mode: ctx.mode,
			ui: ctx.ui,
		});
	});

	pi.on("before_agent_start", (_event, ctx) => {
		updatePreferredProviderStatus(ctx.model, ctx.sessionManager.getSessionId());
	});

	pi.on("model_select", (event, ctx) => {
		updatePreferredProviderStatus(event.model, ctx.sessionManager.getSessionId());
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		clearPreferredProviderStatus(sessionId);
		releasePreferredProviders(sessionId);
		releaseThinkingCompression(sessionId);
		releaseFingerprint(sessionId);
	});
}
