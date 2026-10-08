/**
 * The x402 payment loop: a fetch wrapper that answers a valid 402 challenge
 * with one signed retry, gated by spending policy and recorded in a ledger.
 *
 * Payment rules (plan: docs/plans/x402-fetch-hook.md, R-2/R-3/R-7):
 * - Pay only when the 402 carries parseable requirements, the requirement is
 *   supported (exact scheme, Base, USDC), the host is allowlisted, and the
 *   amount fits both the per-request and per-day ceilings.
 * - Anything else — a bare 402 like Bu0y's balance signal, a malformed
 *   challenge, an unsupported network — returns to the caller untouched and
 *   the signer is never invoked.
 * - One signed retry maximum; a second 402 is returned as-is.
 * - Every refusal is recorded in the ledger with a reason from the closed
 *   vocabulary; every settled payment records amount and settlement tx.
 *
 * This is deliberately a plain function returning a fetch so any other hook
 * (logging, retry, cache) can wrap it, and so the Proxy/marker layer can add
 * composition on top without changing the flow.
 */
import type { Signer } from "ethers";
import { NULL_LEDGER, type Ledger, type RefusalReason } from "./ledger.ts";
import {
	pickRequirement,
	parsePaymentRequirements,
	signTransferAuthorization,
	type PaymentRequirement,
} from "./sign.ts";

/** Mutable daily-spend tracker shared with the session state. */
export type DailySpend = {
	/** UTC day, `YYYY-MM-DD`. */
	dateUtc: string;
	spentUsdc: number;
};

export type PayingFetchConfig = {
	/** ethers v6 signer (a Wallet, or an EIP-1193-backed signer). */
	signer: Signer;
	/** Hard per-request ceiling in USDC. */
	maxPerRequestUsdc: number;
	/** Hard per-day ceiling in USDC (UTC day); undefined means uncapped. */
	maxPerDayUsdc?: number;
	/** Shared daily counter; mutated in place as payments settle. */
	dailySpend?: DailySpend;
	/**
	 * Hosts eligible for payment (exact hostname, case-insensitive).
	 * Undefined pays any host with a valid challenge; an empty array pays
	 * none. Sessions seed this from the probe results.
	 */
	allowedHosts?: readonly string[];
	/** Payment event ledger; defaults to a no-op. */
	ledger?: Ledger;
	/** Session identifier recorded on ledger entries. */
	sessionId?: string;
	/** Clock override for tests; seconds since the epoch. */
	nowSeconds?: number;
};

/** USDC has 6 decimals; atomic amount → USDC dollars. */
function amountToUsdc(amountAtomic: string): number {
	return Number(amountAtomic) / 1_000_000;
}

function utcDay(nowSeconds: number): string {
	return new Date(nowSeconds * 1000).toISOString().slice(0, 10);
}

function dailySpendFor(config: PayingFetchConfig): DailySpend | undefined {
	if (!config.dailySpend) return undefined;
	const day = utcDay(config.nowSeconds ?? Math.floor(Date.now() / 1000));
	if (config.dailySpend.dateUtc !== day) {
		config.dailySpend.dateUtc = day;
		config.dailySpend.spentUsdc = 0;
	}
	return config.dailySpend;
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

/** Settlement receipt from the paid response; v2 and v1 header names. */
function settlementTx(response: Response): string | undefined {
	const header = response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
	if (!header) return undefined;
	try {
		const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
		const tx = decoded.transaction ?? decoded.txHash ?? decoded.hash;
		return typeof tx === "string" ? tx : undefined;
	} catch {
		return undefined;
	}
}

function urlParts(url: string): { host: string; path: string } {
	try {
		const parsed = new URL(url);
		return { host: parsed.hostname.toLowerCase(), path: parsed.pathname };
	} catch {
		return { host: "", path: "" };
	}
}

/**
 * Wrap `baseFetch` so a valid x402 402 challenge is paid and retried once.
 * The returned function is a drop-in `fetch`.
 */
export function payingFetch(baseFetch: typeof fetch, config: PayingFetchConfig): typeof fetch {
	const ledger = config.ledger ?? NULL_LEDGER;
	const context = { sessionId: config.sessionId };

	return async function payingFetchImpl(
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> {
		// Materialize as a Request up front so the body survives the first
		// attempt and can be re-sent byte-for-byte on the paid retry.
		const original = new Request(input, init);
		const { host, path } = urlParts(original.url);
		const firstResponse = await baseFetch(original.clone());
		if (firstResponse.status !== 402) {
			// Unpaid responses can still carry cost telemetry (Ruvicode's
			// X-Cost); record it without touching the response.
			const xCost = firstResponse.headers.get("x-cost");
			if (xCost !== null) {
				ledger.record({ ...context, host, path, outcome: "observed", usdc: Number(xCost) || undefined });
			}
			return firstResponse;
		}

		const refuse = (reason: RefusalReason): Response => {
			ledger.record({ ...context, host, path, outcome: "refused", reason });
			return firstResponse;
		};

		if (config.allowedHosts !== undefined) {
			if (!host || !config.allowedHosts.some((allowed) => allowed.toLowerCase() === host)) {
				return refuse("host-not-allowed");
			}
		}

		// Inspect a clone: parsing consumes the body, and a response we decide
		// not to pay must reach the caller untouched, body included.
		const parsed = await parsePaymentRequirements(firstResponse.clone());
		if (!parsed.ok) return refuse("unparseable-challenge");
		const requirement = pickRequirement(parsed.requirements);
		if (!requirement) return refuse("unsupported-challenge");

		const usdc = amountToUsdc(requirement.amount);
		if (usdc > config.maxPerRequestUsdc) return refuse("over-request-ceiling");
		const daily = dailySpendFor(config);
		if (daily && config.maxPerDayUsdc !== undefined && daily.spentUsdc + usdc > config.maxPerDayUsdc) {
			return refuse("over-day-ceiling");
		}

		const signed = await signTransferAuthorization(config.signer, requirement, {
			nowSeconds: config.nowSeconds,
		});
		const retry = new Request(original, { headers: new Headers(original.headers) });
		retry.headers.set("X-Payment", buildPaymentHeaderPayload(requirement, signed));
		const paidResponse = await baseFetch(retry);
		if (paidResponse.status !== 402) {
			if (daily) daily.spentUsdc += usdc;
			ledger.record({
				...context,
				host,
				path,
				amountAtomic: requirement.amount,
				usdc,
				outcome: "settled",
				tx: settlementTx(paidResponse),
			});
		}
		return paidResponse;
	};
}
