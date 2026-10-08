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
import { join } from "node:path";
import { createPayingFetch, installPayingFetch, uninstallPayingFetch } from "./hook.ts";
import { fileLedger, NULL_LEDGER, type Ledger } from "./ledger.ts";
import type { DailySpend } from "./pay.ts";
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
	maxPerDayUsdc?: number;
	dailySpend: DailySpend;
	ledger: Ledger;
};

export type PaymentsConfig = {
	/** Wallet key source: literal, `$VAR`, or `!command`. */
	walletPrivateKey?: string;
	maxPerRequestUsdc?: number;
	maxPerDayUsdc?: number;
	allowedHosts?: readonly string[];
};

const sessions = new Map<string, PaymentState>();
const scopes = new Map<string, { ui: { setStatus(key: string, text: string | undefined): void }; mode: string }>();

const STATUS_KEY = "x402-payments";

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
	deps: {
		env?: Record<string, string | undefined>;
		exec?: (command: string) => string;
		cwd?: string;
		ledger?: Ledger;
		ui?: { setStatus(key: string, text: string | undefined): void };
		mode?: string;
	} = {},
): string | undefined {
	if (deps.ui && deps.mode) scopes.set(sessionId, { ui: deps.ui, mode: deps.mode });
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
	const ledger =
		deps.ledger ?? (deps.cwd ? fileLedger(join(deps.cwd, ".pi", "x402-ledger.jsonl")) : NULL_LEDGER);
	const dailySpend: DailySpend = { dateUtc: "", spentUsdc: 0 };
	const payingConfig = {
		signer: resolved.signer,
		maxPerRequestUsdc,
		maxPerDayUsdc: config.maxPerDayUsdc,
		dailySpend,
		allowedHosts,
		ledger,
		sessionId,
	};
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
		maxPerDayUsdc: config.maxPerDayUsdc,
		dailySpend,
		ledger,
	});
	return undefined;
}

export function paymentState(sessionId: string | undefined): PaymentState | undefined {
	return sessionId === undefined ? undefined : sessions.get(sessionId);
}

export function releasePayments(sessionId: string): void {
	const scope = scopes.get(sessionId);
	if (scope?.mode === "tui") scope.ui.setStatus(STATUS_KEY, undefined);
	scopes.delete(sessionId);
	sessions.delete(sessionId);
	// Restore the global fetch only when no other session still needs it.
	if (sessions.size === 0) uninstallPayingFetch(globalThis);
}

/** Refresh the footer status; interactive TUI sessions only. */
export function updatePaymentStatus(sessionId: string | undefined): void {
	if (sessionId === undefined) return;
	const scope = scopes.get(sessionId);
	if (!scope || scope.mode !== "tui") return;
	scope.ui.setStatus(STATUS_KEY, paymentStatusText(sessions.get(sessionId)));
}

function shortAddress(address: string): string {
	return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function formatUsdc(amount: number): string {
	return `$${amount.toFixed(4)}`;
}

/**
 * Footer status text for the payment state, following the preferred-provider
 * pattern: interactive TUI only, never key material. Returns undefined when
 * no wallet is armed so the caller clears the status instead.
 */
export function paymentStatusText(state: PaymentState | undefined): string | undefined {
	if (!state) return undefined;
	const wallet = `x402 ${shortAddress(state.address)}`;
	if (state.maxPerDayUsdc === undefined) {
		return `${wallet} · ${formatUsdc(state.dailySpend.spentUsdc)} today`;
	}
	const spent = state.dailySpend.spentUsdc;
	const atCap = spent >= state.maxPerDayUsdc ? " (at cap)" : "";
	return `${wallet} · ${formatUsdc(spent)} / ${formatUsdc(state.maxPerDayUsdc)} today${atCap}`;
}
