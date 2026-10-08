/**
 * The x402 payment loop: a fetch wrapper that answers a valid 402 challenge
 * with one signed retry.
 *
 * Payment rules (plan: docs/plans/x402-fetch-hook.md, R-2/R-3):
 * - Pay only when the 402 carries parseable requirements, the requirement is
 *   supported (exact scheme, Base, USDC), and the amount is within policy.
 * - Anything else — a bare 402 like Bu0y's balance signal, a malformed
 *   challenge, an unsupported network — returns to the caller untouched and
 *   the signer is never invoked.
 * - One signed retry maximum; a second 402 is returned as-is.
 *
 * This is deliberately a plain function returning a fetch so any other hook
 * (logging, retry, cache) can wrap it, and so Phase 3's Proxy/marker layer
 * can add composition on top without changing the flow.
 */
import type { Signer } from "ethers";
import {
	pickRequirement,
	parsePaymentRequirements,
	signTransferAuthorization,
	type PaymentRequirement,
} from "./sign.ts";

export type PayingFetchConfig = {
	/** ethers v6 signer (a Wallet, or an EIP-1193-backed signer). */
	signer: Signer;
	/** Hard per-request ceiling in USDC. Phase 4 makes this configurable. */
	maxPerRequestUsdc: number;
	/** Clock override for tests; seconds since the epoch. */
	nowSeconds?: number;
};

/** USDC has 6 decimals; atomic amount → USDC dollars. */
function amountToUsdc(amountAtomic: string): number {
	return Number(amountAtomic) / 1_000_000;
}

function buildPaymentHeaderPayload(
	requirement: PaymentRequirement,
	signed: { authorization: Record<string, string>; signature: string },
): string {
	// The v2 shape observed at Surp and Surplus Intelligence; Surp's retry
	// instructions ask for it base64-encoded in the `X-Payment` header.
	const payload = {
		x402Version: 2,
		scheme: requirement.scheme,
		network: requirement.network,
		payload: {
			signature: signed.signature,
			authorization: signed.authorization,
		},
	};
	return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * Wrap `baseFetch` so a valid x402 402 challenge is paid and retried once.
 * The returned function is a drop-in `fetch`.
 */
export function payingFetch(baseFetch: typeof fetch, config: PayingFetchConfig): typeof fetch {
	return async function payingFetchImpl(
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> {
		// Materialize as a Request up front so the body survives the first
		// attempt and can be re-sent byte-for-byte on the paid retry.
		const original = new Request(input, init);
		const firstResponse = await baseFetch(original.clone());
		if (firstResponse.status !== 402) return firstResponse;

		// Inspect a clone: parsing consumes the body, and a response we decide
		// not to pay must reach the caller untouched, body included.
		const parsed = await parsePaymentRequirements(firstResponse.clone());
		if (!parsed.ok) return firstResponse;
		const requirement = pickRequirement(parsed.requirements);
		if (!requirement) return firstResponse;
		if (amountToUsdc(requirement.amount) > config.maxPerRequestUsdc) return firstResponse;

		const signed = await signTransferAuthorization(config.signer, requirement, {
			nowSeconds: config.nowSeconds,
		});
		const retry = new Request(original, { headers: new Headers(original.headers) });
		retry.headers.set("X-Payment", buildPaymentHeaderPayload(requirement, signed));
		return baseFetch(retry);
	};
}
