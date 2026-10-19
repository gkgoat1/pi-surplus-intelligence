import type { Api } from "@earendil-works/pi-ai";

/**
 * Static description of one OpenAI-compatible gateway this extension
 * registers with Pi. The gateways share OpenAI-compatible request dialects
 * (chat completions with reasoning hints, Responses API for GPT-5+), so
 * behavior differences ride on these flags rather than provider checks
 * scattered through the codebase.
 */
export type ProviderDescriptor = {
	/** Pi provider id ("surplus-intelligence", "inferhub", "cheaper-inference"). */
	id: string;
	/** Display name for UI and diagnostics. */
	name: string;
	/**
	 * Base URL passed to Pi and the built-in OpenAI streams. For Surplus this
	 * is the bare host: the savings router rewrites it to `/min{N}/v1` and the
	 * stream layer appends `/v1` on the direct path. InferHub has no savings
	 * routing, so its base URL carries the `/v1` root directly.
	 */
	baseUrl: string;
	/** Model catalog endpoint (`${baseUrl}/v1/models` or equivalent). */
	modelsUrl: string;
	/** Origin/base path for the gateway's Anthropic Messages API. */
	anthropicBaseUrl: string;
	/** Environment variable holding the API key when not set in config. */
	apiKeyEnvVar: string;
	/** Pi API identifier registered for this provider's models. */
	api: Api;
	/** Whether requests may be rewritten to the `/min{N}/v1` savings routes. */
	supportsSavingsRouting: boolean;
	/** Shape of the provider's `/models` catalog entries. */
	catalog: "surplus" | "inferhub" | "cheaper-inference" | "surp" | "bu0y" | "ruvicode";
	/**
	 * Whether the catalog endpoint answers without a key (probed; see
	 * docs/probe-results.md). Such providers attempt discovery keyless and
	 * omit the Authorization header until a key exists.
	 */
	publicCatalog?: boolean;
	/**
	 * Whether a request may proceed with no API key at all. Surp's `surp/free`
	 * route works unauthenticated; other keyless providers register their
	 * catalogs but need a key (or, for Surp's paid routes, the Phase 3 wallet
	 * hook) to serve inference. Such providers register with
	 * `authHeader: false` (Pi refuses keyless requests otherwise) and the
	 * stream layer adds the Bearer header itself when a key exists.
	 */
	allowsKeylessRequests?: boolean;
	/**
	 * Whether the gateway exposes an Anthropic Messages endpoint and Claude
	 * models should also register under a `-anthropic` provider. Only the
	 * three original gateways are known to support it; Surp/Bu0y/Ruvicode have
	 * no confirmed Anthropic-compatible endpoint, so they must not spawn
	 * variants that would fail at request time.
	 */
	supportsAnthropicMessages?: boolean;
};

export const SURPLUS_INTELLIGENCE: ProviderDescriptor = {
	id: "surplus-intelligence",
	name: "Surplus Intelligence",
	baseUrl: "https://api.surplusintelligence.ai",
	modelsUrl: "https://api.surplusintelligence.ai/v1/models",
	anthropicBaseUrl: "https://api.surplusintelligence.ai/anthropic",
	apiKeyEnvVar: "SURPLUS_INTELLIGENCE_API_KEY",
	api: "surplus-openai-completions",
	supportsSavingsRouting: true,
	catalog: "surplus",
	supportsAnthropicMessages: true,
};

export const INFERHUB: ProviderDescriptor = {
	id: "inferhub",
	name: "InferHub",
	baseUrl: "https://api.inferhub.dev/v1",
	modelsUrl: "https://api.inferhub.dev/v1/models",
	anthropicBaseUrl: "https://api.inferhub.dev",
	apiKeyEnvVar: "INFERHUB_API_KEY",
	api: "inferhub-openai-completions",
	supportsSavingsRouting: false,
	catalog: "inferhub",
	supportsAnthropicMessages: true,
};

export const CHEAPER_INFERENCE: ProviderDescriptor = {
	id: "cheaper-inference",
	name: "Cheaper Inference",
	baseUrl: "https://api.cheaperinference.com/v1",
	modelsUrl: "https://api.cheaperinference.com/v1/models",
	anthropicBaseUrl: "https://api.cheaperinference.com",
	apiKeyEnvVar: "CHEAPER_INFERENCE_API_KEY",
	api: "openai-completions",
	supportsSavingsRouting: false,
	catalog: "cheaper-inference",
	supportsAnthropicMessages: true,
};

export const SURP: ProviderDescriptor = {
	id: "surp",
	name: "Surp",
	baseUrl: "https://surp.ivc.lol/v1",
	modelsUrl: "https://surp.ivc.lol/v1/models",
	anthropicBaseUrl: "https://surp.ivc.lol",
	apiKeyEnvVar: "SURP_API_KEY",
	api: "surp-openai-completions",
	supportsSavingsRouting: false,
	catalog: "surp",
	publicCatalog: true,
	allowsKeylessRequests: true,
};

export const BU0Y: ProviderDescriptor = {
	id: "bu0y",
	name: "Bu0y",
	baseUrl: "https://api.bu0y.com/v1",
	modelsUrl: "https://api.bu0y.com/v1/models",
	anthropicBaseUrl: "https://api.bu0y.com",
	apiKeyEnvVar: "BU0Y_API_KEY",
	api: "bu0y-openai-completions",
	supportsSavingsRouting: false,
	catalog: "bu0y",
	publicCatalog: true,
};

export const RUVICODE: ProviderDescriptor = {
	id: "ruvicode",
	name: "Ruvicode",
	baseUrl: "https://api.ruvicode.com/v1",
	modelsUrl: "https://api.ruvicode.com/v1/models",
	anthropicBaseUrl: "https://api.ruvicode.com",
	apiKeyEnvVar: "RUVICODE_API_KEY",
	api: "ruvicode-openai-completions",
	supportsSavingsRouting: false,
	catalog: "ruvicode",
	publicCatalog: true,
};

export const PROVIDERS: ProviderDescriptor[] = [
	SURPLUS_INTELLIGENCE,
	INFERHUB,
	CHEAPER_INFERENCE,
	SURP,
	BU0Y,
	RUVICODE,
];

export const PROVIDER_BY_ID: ReadonlyMap<string, ProviderDescriptor> = new Map(
	PROVIDERS.map((descriptor) => [descriptor.id, descriptor]),
);
