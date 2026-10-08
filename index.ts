/**
 * Pi extension for Surplus Intelligence, InferHub, and Cheaper Inference.
 *
 * Registers each gateway's OpenAI-compatible provider and discovers its model
 * catalog. Claude models are also registered separately with Pi's native
 * Anthropic Messages adapter. GPT-5-and-later OpenAI requests use the Responses
 * API; earlier models use chat completions.
 *
 * Usage:
 *   export SURPLUS_INTELLIGENCE_API_KEY="..."
 *   pi
 *   /model surplus-intelligence/kimi-k2.7-code
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROVIDERS } from "./src/constants.ts";
import { anthropicClaudeModels, fetchModels, fallbackModels } from "./src/models.ts";
import {
	loadProvidersFileConfig,
	loadPaymentsFileConfig,
	resolveProviderCredentials,
} from "./src/provider-config.ts";
import { loadStreamHelpers } from "./src/loader.ts";
import {
	clearPreferredProviderStatus,
	configurePreferredProviders,
	releasePreferredProviders,
	updatePreferredProviderStatus,
} from "./src/preferred-providers.ts";
import { configureFingerprint, releaseFingerprint } from "./src/fingerprint.ts";
import { configurePayments, releasePayments, updatePaymentStatus } from "./src/x402/payments.ts";
import { createGatewayStreamSimple } from "./src/stream.ts";
import {
	configureThinkingCompression,
	releaseThinkingCompression,
} from "./src/thinking-compression.ts";
import { homedir } from "os";

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

	const { providers: fileConfig, diagnostics } = loadProvidersFileConfig(homedir());
	const { payments: paymentsFileConfig, diagnostics: paymentsDiagnostics } = loadPaymentsFileConfig(homedir());
	for (const diagnostic of [...diagnostics, ...paymentsDiagnostics]) {
		console.error(`pi-surplus-intelligence: ${diagnostic}`);
	}

	const streamSimple = createGatewayStreamSimple(helpers);

	for (const descriptor of PROVIDERS) {
		if (fileConfig[descriptor.id]?.enabled === false) continue;
		const credentials = resolveProviderCredentials(descriptor, fileConfig[descriptor.id]);

		let models = fallbackModels(descriptor);
		// Providers with a public catalog (Surp, Bu0y, Ruvicode — probed in
		// docs/probe-results.md) are discovered without a key; keyed-only
		// providers keep the old behavior of skipping discovery when keyless.
		if (credentials.ok || descriptor.publicCatalog) {
			try {
				models = await fetchModels(descriptor, credentials.ok ? credentials.apiKey : undefined);
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

		const claudeModels = anthropicClaudeModels(models);
		if (claudeModels.length > 0) {
			// Use Pi's native Anthropic adapter so Claude thinking blocks, signatures,
			// and tool-use/result turns follow Anthropic Messages semantics end to end.
			pi.registerProvider(`${descriptor.id}-anthropic`, {
				name: `${descriptor.name} (Anthropic Messages)`,
				baseUrl: descriptor.anthropicBaseUrl,
				apiKey,
				api: "anthropic-messages",
				models: claudeModels,
			});
		}
	}

	pi.on("session_start", (_event, ctx) => {
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
		const paymentsDiagnostic = configurePayments(
			ctx.sessionManager.getSessionId(),
			{
				walletPrivateKey: paymentsFileConfig?.privateKey,
				maxPerRequestUsdc: paymentsFileConfig?.maxPerRequestUsdc,
				maxPerDayUsdc: paymentsFileConfig?.maxPerDayUsdc,
				allowedHosts: paymentsFileConfig?.allowedHosts,
			},
			{ cwd: ctx.cwd, ui: ctx.ui, mode: ctx.mode },
		);
		updatePaymentStatus(ctx.sessionManager.getSessionId());
		for (const diagnostic of [preferredDiagnostic, compressionDiagnostic, paymentsDiagnostic]) {
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
		updatePaymentStatus(ctx.sessionManager.getSessionId());
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
		releasePayments(sessionId);
	});
}
