/**
 * Composable fetch hook for x402 payments.
 *
 * `createPayingFetch` wraps a base fetch in a Proxy carrying a marker key,
 * `Symbol.for("pi-surplus-intelligence:x402-fetch")`. The marker is global so
 * separately-bundled copies of this extension recognize each other's hooks.
 *
 * Composition contract (plan R-1, docs/plans/x402-fetch-hook.md):
 * - The marker is readable via the symbol and invisible to enumeration, so
 *   hooks, spreads, and serializers that don't know about it are unaffected.
 * - The marker value is `{ version, inner }`: `inner` is the original base
 *   fetch, so a hook that needs to re-order (e.g. run inside the payment
 *   loop) can reach it deliberately.
 * - Wrapping an already-marked fetch reconfigures in place: the new config
 *   replaces the old, and `inner` still points at the original base fetch.
 *   Payment stays a single loop no matter how many times it is installed.
 * - Other hooks compose by wrapping the paying fetch like any fetch (outside
 *   it), or by wrapping `inner` and re-applying (inside it).
 */
import { payingFetch, type PayingFetchConfig } from "./pay.ts";

export const X402_FETCH_MARKER: unique symbol = Symbol.for("pi-surplus-intelligence:x402-fetch");

export type PayingFetchMarker = {
	version: 1;
	/** The original un-wrapped fetch, for deliberate re-ordering. */
	inner: typeof fetch;
	/** Mutable so re-wrapping updates the live loop rather than stacking. */
	config: PayingFetchConfig;
};

type MarkedFetch = typeof fetch & { [X402_FETCH_MARKER]?: PayingFetchMarker };

/**
 * Wrap `baseFetch` with the x402 payment flow. If `baseFetch` already carries
 * the marker, its config is updated in place and the same Proxy is returned —
 * never a second payment loop.
 */
export function createPayingFetch(baseFetch: typeof fetch, config: PayingFetchConfig): typeof fetch {
	const existing = (baseFetch as MarkedFetch)[X402_FETCH_MARKER];
	if (existing) {
		existing.config = config;
		return baseFetch;
	}

	const state: PayingFetchMarker = { version: 1, inner: baseFetch, config };
	const target = async function fetchTarget(input: RequestInfo | URL, init?: RequestInit) {
		return payingFetch(state.inner, state.config)(input, init);
	} as typeof fetch;

	return new Proxy(target, {
		get(fn, prop, receiver) {
			if (prop === X402_FETCH_MARKER) return state;
			return Reflect.get(fn, prop, receiver);
		},
		has(fn, prop) {
			if (prop === X402_FETCH_MARKER) return true;
			return Reflect.has(fn, prop);
		},
		getOwnPropertyDescriptor(fn, prop) {
			if (prop === X402_FETCH_MARKER) {
				return { value: state, enumerable: false, configurable: true, writable: false };
			}
			return Reflect.getOwnPropertyDescriptor(fn, prop);
		},
	});
}
