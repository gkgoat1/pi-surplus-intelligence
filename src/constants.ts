import type { Api } from "@earendil-works/pi-ai";

/**
 * Static description of one OpenAI-compatible gateway this extension
 * registers with Pi. Surplus Intelligence and InferHub share the request
 * dialect (chat completions with reasoning hints, Responses API for GPT-5+),
 * so behavior differences ride on these flags rather than provider checks
 * scattered through the codebase.
 */
export type ProviderDescriptor = {
	/** Pi provider id ("surplus-intelligence", "inferhub"). */
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
	/** Environment variable holding the API key when not set in config. */
	apiKeyEnvVar: string;
	/** Pi API identifier registered for this provider's models. */
	api: Api;
	/** Whether requests may be rewritten to the `/min{N}/v1` savings routes. */
	supportsSavingsRouting: boolean;
	/** Shape of the provider's `/models` catalog entries. */
	catalog: "surplus" | "inferhub";
};

export const SURPLUS_INTELLIGENCE: ProviderDescriptor = {
	id: "surplus-intelligence",
	name: "Surplus Intelligence",
	baseUrl: "https://api.surplusintelligence.ai",
	modelsUrl: "https://api.surplusintelligence.ai/v1/models",
	apiKeyEnvVar: "SURPLUS_INTELLIGENCE_API_KEY",
	api: "surplus-openai-completions",
	supportsSavingsRouting: true,
	catalog: "surplus",
};

export const INFERHUB: ProviderDescriptor = {
	id: "inferhub",
	name: "InferHub",
	baseUrl: "https://api.inferhub.dev/v1",
	modelsUrl: "https://api.inferhub.dev/v1/models",
	apiKeyEnvVar: "INFERHUB_API_KEY",
	api: "inferhub-openai-completions",
	supportsSavingsRouting: false,
	catalog: "inferhub",
};

export const PROVIDERS: ProviderDescriptor[] = [SURPLUS_INTELLIGENCE, INFERHUB];

export const PROVIDER_BY_ID: ReadonlyMap<string, ProviderDescriptor> = new Map(
	PROVIDERS.map((descriptor) => [descriptor.id, descriptor]),
);
