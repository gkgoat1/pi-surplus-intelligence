/**
 * Configurable retry policies for catalog discovery and model requests.
 *
 * Motivation: when a gateway's model-list endpoint is unreachable at
 * startup, the extension used to register only its small fallback list after
 * a single attempt. Pi's model resolver then silently substitutes an
 * unavailable configured model (e.g. with `anthropic/claude-opus-4-8`), which
 * fails and takes the agent offline. Likewise, once the fixed request retry
 * budget was exhausted, the error propagated to Pi, which could fall back to
 * another provider. Both budgets are now configurable — including
 * `"maxAttempts": "infinite"` — so Pi never falls back to another provider
 * unless the user explicitly allows it (by lowering or omitting these).
 *
 * Explicit Pi cancellation (abort) always wins immediately, even with an
 * infinite budget. Permanent request errors (401/402/403/404) are never
 * retried regardless of budget: retrying an auth failure is pointless and
 * retrying a 402 would drain a configured x402 wallet.
 */
import { PROVIDER_BY_ID } from "./constants.ts";
import type { RetryFileSettings } from "./provider-config.ts";

/** A fully resolved retry policy. `maxAttempts` may be `Infinity`. */
export type RetryPolicy = {
	/** Total attempts (initial try + retries). `Infinity` retries forever. */
	maxAttempts: number;
	/** Delay before the first retry; doubles each attempt. */
	baseDelayMs: number;
	/** Cap for the per-attempt delay. */
	maxDelayMs: number;
};

/**
 * Discovery defaults preserve the historical behavior: a single attempt per
 * catalog endpoint, then fallback models. Users opt into retries explicitly.
 */
export const DEFAULT_DISCOVERY_RETRY: RetryPolicy = {
	maxAttempts: 1,
	baseDelayMs: 1_000,
	maxDelayMs: 30_000,
};

/** Request defaults mirror the previously hardcoded stream.ts budget. */
export const DEFAULT_REQUEST_RETRY: RetryPolicy = {
	maxAttempts: 15,
	baseDelayMs: 500,
	maxDelayMs: 60_000,
};

/**
 * Bu0y reserves the worst-case cost before running a fill, so a replayed
 * request can pay twice for one answer (docs/plans/x402-fetch-hook.md §Bu0y).
 * Its default budget stays a single retry; an explicit `maxAttempts` in
 * config overrides this cap (the user's choice, payment limits still apply).
 */
export const PREPAID_FILL_MAX_ATTEMPTS = 2;

/** Delay before retry `attempt` (1-based: the wait after attempt N fails). */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
	return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
}

/**
 * Wait between attempts without keeping an agent alive after Pi has
 * cancelled it. Long-running workflow agents can otherwise race an aborted
 * request's retry timer and appear to hang. Resolves `false` on abort.
 */
export function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => finish(true), delayMs);
		const onAbort = () => finish(false);
		function finish(retry: boolean): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(retry);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export type RetryCallback = (info: {
	/** The attempt that just failed (1-based). */
	attempt: number;
	/** The configured cap; `Infinity` when retrying forever. */
	maxAttempts: number;
	/** How long `withRetries` will wait before the next attempt. */
	delayMs: number;
	error: unknown;
}) => void;

/**
 * Run `fn` until it succeeds, the attempt budget is exhausted, or the signal
 * aborts. Rejects with the last failure (or an abort error when cancelled
 * during the backoff wait). `policy.maxAttempts === Infinity` retries
 * forever; only success or abort ends the loop.
 */
export async function withRetries<T>(
	fn: () => Promise<T>,
	policy: RetryPolicy,
	options: { signal?: AbortSignal; onRetry?: RetryCallback } = {},
): Promise<T> {
	let lastFailure: unknown;
	for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
		if (options.signal?.aborted) throw new Error("aborted");
		try {
			return await fn();
		} catch (error) {
			lastFailure = error;
		}
		if (attempt === policy.maxAttempts) break;
		const delayMs = retryDelayMs(policy, attempt);
		options.onRetry?.({ attempt, maxAttempts: policy.maxAttempts, delayMs, error: lastFailure });
		if (!(await waitForRetry(delayMs, options.signal))) throw new Error("aborted");
	}
	throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure));
}

/** Merge retry settings; defined fields in `override` win. */
export function mergeRetrySettings(
	base: RetryFileSettings | undefined,
	override: RetryFileSettings | undefined,
): RetryFileSettings | undefined {
	if (!base) return override;
	if (!override) return base;
	// Parsed settings only ever carry defined fields, so spread merges cleanly
	// (an explicit `undefined` key would fail a deepStrictEqual against the
	// merged shape callers expect).
	return { ...base, ...override };
}

function resolvePolicy(defaults: RetryPolicy, settings: RetryFileSettings | undefined): RetryPolicy {
	if (!settings) return defaults;
	return {
		maxAttempts: settings.maxAttempts ?? defaults.maxAttempts,
		baseDelayMs: settings.baseDelayMs ?? defaults.baseDelayMs,
		maxDelayMs: settings.maxDelayMs ?? defaults.maxDelayMs,
	};
}

/** Resolve the catalog-discovery budget for one provider. */
export function resolveDiscoveryPolicy(settings?: RetryFileSettings): RetryPolicy {
	return resolvePolicy(DEFAULT_DISCOVERY_RETRY, settings);
}

/**
 * Resolve the per-request budget for one provider. Bu0y's prepaid-fill cap
 * applies only when the user has not set `maxAttempts` explicitly.
 */
export function resolveRequestPolicy(providerId: string, settings?: RetryFileSettings): RetryPolicy {
	const prepaidFill = PROVIDER_BY_ID.get(providerId)?.catalog === "bu0y";
	const defaults =
		prepaidFill && settings?.maxAttempts === undefined
			? { ...DEFAULT_REQUEST_RETRY, maxAttempts: PREPAID_FILL_MAX_ATTEMPTS }
			: DEFAULT_REQUEST_RETRY;
	return resolvePolicy(defaults, settings);
}
