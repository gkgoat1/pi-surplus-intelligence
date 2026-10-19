/**
 * Classifier (decisions) model support.
 *
 * Surplus Intelligence serves TypeSafe's Jev decisions models through its
 * `/v1/decisions` native-schema rail: a System One-shaped request
 * (`{ model, state, questions }`, with public `bool` questions sent as
 * wire-level `noul`) answered with `{ answers, usage }`. pi-ai >= 1.3 ships
 * the protocol runner (`classifySystemOne`) with a pluggable transport, so
 * this module supplies only the Surplus transport and the catalog mapping.
 *
 * Probed 2026-10-19: Surplus answers the rail (402 without credentials);
 * Surp, Bu0y, and Ruvicode have no decisions endpoint, so only the
 * surplus-intelligence provider registers classifier models.
 */
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierOptions, ClassifierResult } from "@earendil-works/pi-ai";
import type { ProviderDescriptor } from "./constants.ts";
import { KEYLESS_SENTINEL, stripAuthorizationFetch } from "./stream.ts";
import type { ClassifySystemOne, SystemOneTransport } from "./types.ts";

/** Classifier API id for the Surplus decisions rail. */
export const DECISIONS_API: ClassifierApi = "surplus-decisions";

/**
 * A catalog entry belongs to the decisions rail when its modality is
 * "decisions" or it advertises the decisions parameter. Jev catalog entries
 * carry both (see docs/probe-results.md and the live catalog).
 */
export function isDecisionsModel(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null) return false;
	const record = entry as Record<string, unknown>;
	const architecture = record.architecture;
	if (
		typeof architecture === "object" &&
		architecture !== null &&
		(architecture as Record<string, unknown>).modality === "decisions"
	) {
		return true;
	}
	const params = record.supported_parameters ?? record.supported_features;
	return Array.isArray(params) && params.includes("decisions");
}

function contextWindowOf(record: Record<string, unknown>): number {
	const params = [
		...(Array.isArray(record.supported_parameters) ? record.supported_parameters : []),
		...(Array.isArray(record.supported_features) ? record.supported_features : []),
	];
	if (params.includes("long_context_262k")) return 262_144;
	if (params.includes("context_64k")) return 65_536;
	return 32_768;
}

/**
 * Map a decisions-rail catalog entry to a Pi classifier model. Jev meters
 * input tokens only (completion price is 0), per the catalog.
 */
export function mapClassifierModel(entry: unknown, descriptor: ProviderDescriptor): any {
	if (typeof entry !== "object" || entry === null) return undefined;
	const record = entry as Record<string, unknown>;
	if (typeof record.id !== "string" || !isDecisionsModel(entry)) return undefined;
	const pricing = (typeof record.pricing === "object" && record.pricing !== null
		? record.pricing
		: {}) as Record<string, unknown>;
	const prompt = typeof pricing.prompt === "string" ? Number(pricing.prompt) : 0;
	return {
		id: record.id,
		type: "classifier",
		api: DECISIONS_API,
		name: typeof record.name === "string" && record.name ? record.name : record.id,
		input: ["text"],
		cost: {
			input: Number.isFinite(prompt) ? prompt * 1_000_000 : 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: contextWindowOf(record),
		provider: descriptor.id,
	};
}

/** Fallback classifier models when catalog discovery fails. */
export function classifierFallbackModels(descriptor: ProviderDescriptor): any[] {
	return [
		{
			id: "jev-1.14",
			type: "classifier",
			api: DECISIONS_API,
			name: "JEV 1.14 (TypeSafe)",
			input: ["text"],
			cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 65_536,
			provider: descriptor.id,
		},
		{
			id: "jev-1.13",
			type: "classifier",
			api: DECISIONS_API,
			name: "JEV 1.13 (TypeSafe)",
			input: ["text"],
			cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			provider: descriptor.id,
		},
	];
}

/**
 * Build the decisions classifier for a descriptor. The transport points
 * System One at the gateway's `/v1/decisions` rail; everything else (wire
 * mapping, retries, answer parsing) is pi-ai's runner.
 *
 * Auth: a real API key flows through as a Bearer header. The keyless sentinel
 * (or no key) passes the runner's apiKey presence check, but the
 * Authorization header is stripped before the wire — a keyless request is
 * answered by the x402 payment hook (which pays the 402 when a wallet is
 * armed) instead of a bogus Bearer token.
 */
export function createDecisionsClassifier(
	classifySystemOne: ClassifySystemOne,
): { classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?: ClassifierOptions): Promise<ClassifierResult> } {
	const transport: SystemOneTransport = {
		api: DECISIONS_API,
		label: "Surplus Decisions",
		url: (model) => new URL("v1/decisions", `${model.baseUrl.replace(/\/+$/, "")}/`),
		payload: (model, request) => ({ model: model.id, ...request }),
		output: (body) => {
			if (typeof body !== "object" || body === null) {
				throw new Error("Surplus Decisions returned an unexpected response");
			}
			return body as Record<string, unknown>;
		},
	};
	return {
		classify(model, context, options) {
			const keyless = !options?.apiKey || options.apiKey === KEYLESS_SENTINEL;
			const effective: ClassifierOptions = {
				...options,
				apiKey: keyless ? KEYLESS_SENTINEL : options?.apiKey,
				fetch: keyless
					? stripAuthorizationFetch(options?.fetch ?? globalThis.fetch)
					: options?.fetch,
			};
			return classifySystemOne(transport, model, context, effective);
		},
	};
}
