/**
 * Session-scoped x402 payment state.
 *
 * `configurePayments` runs at session start: it resolves the wallet (config
 * or environment), builds the paying fetch over `globalThis.fetch`, and
 * stores both so the stream layer can attach the fetch to provider requests
 * and direct call sites share one configuration. `releasePayments` drops the
 * state at session shutdown.
 *
 * Without a configured wallet this module is inert: no fetch is wrapped and
 * nothing about provider requests changes.
 */
import { createPayingFetch, installPayingFetch, uninstallPayingFetch } from "./hook.ts";
import { resolveWallet } from "./wallet.ts";
import type { Signer } from "ethers";

/** Hosts that probed `402 x402` on 2026-10-08 (docs/probe-results.md). */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
	"surp.ivc.lol",
	"api.surplusintelligence.ai",
];

const DEFAULT_MAX_PER_REQUEST_USDC = 0.25;

export type PaymentState = {
	signer: Signer;
	address: string;
	fetch: typeof fetch;
	allowedHosts: readonly string[];
	maxPerRequestUsdc: number;
};

export type PaymentsConfig = {
	/** Wallet key source: literal, `$VAR`, or `!command`. */
	walletPrivateKey?: string;
	maxPerRequestUsdc?: number;
	allowedHosts?: readonly string[];
};

const sessions = new Map<string, PaymentState>();

/** Exact hostname match, case-insensitive. No subdomain wildcards. */
export function hostAllowed(hostname: string, allowlist: readonly string[]): boolean {
	const normalized = hostname.toLowerCase();
	return allowlist.some((host) => host.toLowerCase() === normalized);
}

/**
 * Configure payments for a session. Returns a human-readable diagnostic when
 * a wallet was configured but unusable; undefined when payments are simply
 * off (no wallet anywhere) or configured cleanly.
 */
export function configurePayments(
	sessionId: string,
	config: PaymentsConfig,
	deps: { env?: Record<string, string | undefined>; exec?: (command: string) => string } = {},
): string | undefined {
	const resolved = resolveWallet(config.walletPrivateKey, deps);
	if (!resolved.ok) {
		sessions.delete(sessionId);
		// Only surface a diagnostic when the user tried to configure a wallet.
		return config.walletPrivateKey !== undefined || deps.env?.X402_WALLET_KEY || process.env.X402_WALLET_KEY
			? `x402 payments disabled: ${resolved.reason}`
			: undefined;
	}
	const maxPerRequestUsdc = config.maxPerRequestUsdc ?? DEFAULT_MAX_PER_REQUEST_USDC;
	const allowedHosts = config.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
	const payingConfig = { signer: resolved.signer, maxPerRequestUsdc };
	const fetchWithPay = createPayingFetch(globalThis.fetch, payingConfig);
	// Direct call sites (Responses-API path, model discovery) call the global
	// fetch; wrap it so they pay too. Idempotent via the marker.
	installPayingFetch(globalThis, payingConfig);
	sessions.set(sessionId, {
		signer: resolved.signer,
		address: resolved.address,
		fetch: fetchWithPay,
		allowedHosts,
		maxPerRequestUsdc,
	});
	return undefined;
}

export function paymentState(sessionId: string | undefined): PaymentState | undefined {
	return sessionId === undefined ? undefined : sessions.get(sessionId);
}

export function releasePayments(sessionId: string): void {
	sessions.delete(sessionId);
	// Restore the global fetch only when no other session still needs it.
	if (sessions.size === 0) uninstallPayingFetch(globalThis);
}
