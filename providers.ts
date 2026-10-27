/**
 * pi-ai entrypoint: the same gateways, without the Pi extension surface.
 *
 * `index.ts` registers providers through pi-coding-agent's ExtensionAPI (with
 * sessions, UI status, and the config-file auth flow). This module exposes the
 * same providers as plain pi-ai `Provider` objects for any pi-ai consumer —
 * pi-durable's `models.setProvider(...)`, a standalone `Models` registry, or
 * direct `streamSimple` calls:
 *
 * ```ts
 * import { createModels } from "@earendil-works/pi-ai/models";
 * import { createGatewayProviders } from "pi-surplus-intelligence-extension/providers";
 *
 * const models = createModels();
 * for (const provider of await createGatewayProviders()) {
 *   models.setProvider(provider);
 * }
 * ```
 *
 * Everything from the extension applies here: live catalog discovery with
 * fallbacks, savings routing, preferred-provider routes are pi-coding-agent
 * features and are NOT included (no session lifecycle exists in this
 * context), GPT-5+ Responses routing, Jev classifier models on the Surplus
 * decisions rail, and optional x402 wallet payments through the same paying
 * fetch hook (keyless Surp routes work without a wallet).
 *
 * Peer dependency: `@earendil-works/pi-ai >= 1.2` (the System One runner is
 * imported statically; on older pi-ai this module fails to load).
 */
import { Wallet, type Signer } from "ethers";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { Api, Model, Provider, ProviderHeaders, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { stream as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { classifySystemOne } from "@earendil-works/pi-ai/api/system-one-shared";
import type { ApiKeyAuth, AuthResult } from "@earendil-works/pi-ai";
import { PROVIDERS, type ProviderDescriptor } from "./src/constants.ts";
import { fetchCatalogEntries, fallbackModels, mapGatewayModel, withProvider } from "./src/models.ts";
import {
	classifierFallbackModels,
	createDecisionsClassifier,
	DECISIONS_API,
	mapClassifierModel,
} from "./src/classifiers.ts";
import { resolveProviderCredentials, loadProvidersFileConfig, loadPaymentsFileConfig } from "./src/provider-config.ts";
import { createGatewayStreamSimple, KEYLESS_SENTINEL } from "./src/stream.ts";
import { createPayingFetch } from "./src/x402/hook.ts";
import { DEFAULT_ALLOWED_HOSTS } from "./src/x402/payments.ts";
import { fileLedger, NULL_LEDGER } from "./src/x402/ledger.ts";
import type { DailySpend } from "./src/x402/pay.ts";
import type { StreamHelpers } from "./src/types.ts";
import { homedir } from "os";

export type GatewayPaymentsOptions = {
	/** ethers v6 Signer, or a 0x-prefixed 32-byte private key. */
	wallet: Signer | string;
	maxPerRequestUsdc?: number;
	maxPerDayUsdc?: number;
	/** Replaces the probe-seeded default allowlist when given. */
	allowedHosts?: readonly string[];
	/** JSONL ledger destination; no ledger when omitted. */
	ledgerPath?: string;
};

export type GatewayProvidersOptions = {
	/** Limit to these provider ids; default: all six gateways. */
	providers?: string[];
	/** Explicit per-provider API keys; win over the config file and env. */
	apiKeys?: Record<string, string>;
	/** x402 wallet payments (plan: docs/plans/x402-fetch-hook.md). */
	payments?: GatewayPaymentsOptions;
	/** Skip the eager catalog fetch; baselines and `fetchModels` still work. */
	skipDiscovery?: boolean;
	/** Directory holding `.pi/surplus-intelligence.json`; defaults to the user home. */
	configDir?: string;
	/** Test seam: replace the pi-ai built-in stream imports. */
	helpers?: StreamHelpers;
};

const DEFAULT_MAX_PER_REQUEST_USDC = 0.25;

function directHelpers(): StreamHelpers {
	return {
		// SAFETY: pi-ai's built-in streams take the branded TranscriptContext while
		// StreamHelpers uses the looser Context type; TranscriptContext is
		// structurally a Context, and the runtime treats both identically.
		completionsStream: completionsStream as unknown as StreamHelpers["completionsStream"],
		// SAFETY: same TranscriptContext/Context brand bridge as above.
		responsesStream: responsesStream as unknown as StreamHelpers["responsesStream"],
		createAssistantMessageEventStream,
		transcript: { getCurrentSystemPrompt, getCurrentTools },
		// SAFETY: our SystemOneTransport mirrors pi-ai's transport contract
		// (verified against its dist type in 1.4.0); the cast bridges the
		// nominal difference without changing runtime behavior.
		classifySystemOne: classifySystemOne as unknown as StreamHelpers["classifySystemOne"],
	};
}

/**
 * Auth for one gateway. A stored credential wins, then an explicit key, then
 * the config file, then the environment. Keyless-capable providers always
 * resolve — to the sentinel when nothing is configured — so the provider is
 * usable without credentials (the stream layer keeps the sentinel off the
 * wire, and the x402 hook answers 402s when a wallet is configured).
 */
function gatewayAuth(
	descriptor: ProviderDescriptor,
	fileKey: string | undefined,
	explicitKey: string | undefined,
): ApiKeyAuth {
	return {
		name: `${descriptor.name} API key`,
		resolve: async ({ credential }) => {
			const fromCredential = credential?.key;
			const resolved =
				typeof fromCredential === "string" && fromCredential.trim().length > 0
					? ({ ok: true, apiKey: fromCredential, source: "stored credential" } as const)
					: typeof explicitKey === "string" && explicitKey.trim().length > 0
						? ({ ok: true, apiKey: explicitKey, source: "explicit key" } as const)
						: resolveProviderCredentials(descriptor, fileKey ? { apiKey: fileKey } : undefined);
			if (resolved.ok) {
				const result: AuthResult = { auth: { apiKey: resolved.apiKey }, source: resolved.source };
				return result;
			}
			if (descriptor.allowsKeylessRequests) {
				return {
					auth: { apiKey: KEYLESS_SENTINEL },
					source: "keyless (x402 wallet or free route)",
				} satisfies AuthResult;
			}
			return undefined;
		},
	};
}

function buildPayingFetch(
	payments: GatewayPaymentsOptions,
	ledgerPath: string | undefined,
): typeof fetch {
	const signer = typeof payments.wallet === "string" ? new Wallet(payments.wallet) : payments.wallet;
	return createPayingFetch(globalThis.fetch, {
		signer,
		maxPerRequestUsdc: payments.maxPerRequestUsdc ?? DEFAULT_MAX_PER_REQUEST_USDC,
		maxPerDayUsdc: payments.maxPerDayUsdc,
		dailySpend: { dateUtc: "", spentUsdc: 0 } satisfies DailySpend,
		allowedHosts: payments.allowedHosts ?? DEFAULT_ALLOWED_HOSTS,
		ledger: ledgerPath ? fileLedger(ledgerPath) : NULL_LEDGER,
	});
}

/**
 * Create one pi-ai `Provider` per gateway. Discovery failures fall back to
 * each provider's baseline models, mirroring the extension's startup.
 */
export async function createGatewayProviders(
	options: GatewayProvidersOptions = {},
): Promise<Provider<Api>[]> {
	const helpers = options.helpers ?? directHelpers();
	const configDir = options.configDir ?? homedir();
	const { providers: fileConfig } = loadProvidersFileConfig(configDir);
	const { payments: paymentsFileConfig } = loadPaymentsFileConfig(configDir);

	const paymentsOptions: GatewayPaymentsOptions | undefined =
		options.payments ??
		(paymentsFileConfig?.privateKey
			? {
					wallet: paymentsFileConfig.privateKey,
					maxPerRequestUsdc: paymentsFileConfig.maxPerRequestUsdc,
					maxPerDayUsdc: paymentsFileConfig.maxPerDayUsdc,
					allowedHosts: paymentsFileConfig.allowedHosts,
				}
			: undefined);
	const payingFetch = paymentsOptions
		? buildPayingFetch(paymentsOptions, paymentsOptions.ledgerPath)
		: undefined;

	const streamSimpleCore = createGatewayStreamSimple(helpers);
	// With a wallet configured, every provider request goes through the paying
	// fetch; without one, options pass through untouched.
	const streamSimple = payingFetch
		? (model: Model<Api>, context: any, streamOptions?: SimpleStreamOptions) =>
				streamSimpleCore(model, context, { ...streamOptions, fetch: streamOptions?.fetch ?? payingFetch })
		: streamSimpleCore;

	const wanted = new Set(options.providers ?? PROVIDERS.map((d) => d.id));
	const out: Provider<Api>[] = [];

	for (const descriptor of PROVIDERS) {
		if (!wanted.has(descriptor.id)) continue;
		if (fileConfig[descriptor.id]?.enabled === false) continue;

		const fileKey = fileConfig[descriptor.id]?.apiKey;
		const credentials = resolveProviderCredentials(
			descriptor,
			fileKey ? { apiKey: fileKey } : undefined,
		);
		const explicitKey = options.apiKeys?.[descriptor.id];
		const apiKeyForDiscovery =
			(options.apiKeys?.[descriptor.id] ?? (credentials.ok ? credentials.apiKey : undefined)) || undefined;

		let models: any[] = fallbackModels(descriptor);
		const decisionsClassifier =
			descriptor.supportsClassifiers && helpers.classifySystemOne
				? createDecisionsClassifier(helpers.classifySystemOne)
				: undefined;
		let classifierModels: any[] =
			descriptor.supportsClassifiers && decisionsClassifier ? classifierFallbackModels(descriptor) : [];

		if (!options.skipDiscovery && (apiKeyForDiscovery || descriptor.publicCatalog)) {
			try {
				const entries = await fetchCatalogEntries(descriptor, apiKeyForDiscovery);
				const chatModels = entries
					.map((entry) => mapGatewayModel(entry, descriptor))
					.filter((model): model is any => model !== undefined)
					.map((model) => withProvider(model, descriptor));
				if (chatModels.length > 0) models = chatModels;
				if (decisionsClassifier) {
					const discovered = entries
						.map((entry) => mapClassifierModel(entry, descriptor))
						.filter((model): model is any => model !== undefined);
					if (discovered.length > 0) classifierModels = discovered;
				}
			} catch {
				// Keep baselines when discovery fails, same as the extension.
			}
		}

		const classifyImpl =
			decisionsClassifier && payingFetch
				? {
						classify: (model: any, context: any, classifyOptions?: any) =>
							decisionsClassifier.classify(model, context, {
								...classifyOptions,
								fetch: classifyOptions?.fetch ?? payingFetch,
							}),
					}
				: decisionsClassifier;

		out.push(
			createProvider({
				id: descriptor.id,
				name: descriptor.name,
				baseUrl: descriptor.baseUrl,
				auth: { apiKey: gatewayAuth(descriptor, fileKey, explicitKey) },
				models: [...models, ...classifierModels],
				api: {
					[descriptor.api]: {
						stream: streamSimple,
						streamSimple,
					},
				},
				...(classifyImpl ? { classifiers: { [DECISIONS_API]: classifyImpl } } : {}),
				fetchModels: async () => {
					const entries = await fetchCatalogEntries(descriptor, apiKeyForDiscovery);
					const chat = entries
						.map((entry) => mapGatewayModel(entry, descriptor))
						.filter((model): model is any => model !== undefined)
						.map((model) => withProvider(model, descriptor));
					if (!decisionsClassifier) return chat;
					const classifiers = entries
						.map((entry) => mapClassifierModel(entry, descriptor))
						.filter((model): model is any => model !== undefined);
					return [...chat, ...classifiers];
				},
			} as any),
		);
	}
	return out;
}

export { PROVIDERS, KEYLESS_SENTINEL, DEFAULT_ALLOWED_HOSTS };
export type { ProviderDescriptor };
