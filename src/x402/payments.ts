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
import { JsonRpcProvider } from "ethers";
import { createPayingFetch, installPayingFetch, uninstallPayingFetch } from "./hook.ts";
import { fileLedger, NULL_LEDGER, type Ledger } from "./ledger.ts";
import type { DailySpend } from "./pay.ts";
import { resolveWallet } from "./wallet.ts";
import { autofund } from "./funding/autofund.ts";
import { resolveFunding } from "./funding/config.ts";
import { ethersDriver } from "./funding/ethers-driver.ts";
import { CHAINS } from "./funding/types.ts";
import { SmartWalletSigner } from "./smart-wallet.ts";
import { ecdsaBareScheme, safeMessageScheme, type WalletScheme } from "./wallet-schemes.ts";
import type { FundingFileConfig, SmartWalletFileConfig } from "../provider-config.ts";
import { SigningKey, type Signer } from "ethers";

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
	/** A smart contract wallet (ERC-1271); takes precedence over walletPrivateKey. */
	smartWallet?: SmartWalletFileConfig;
	/** Autofund policy (x402 wallet top-ups via swaps). */
	funding?: FundingFileConfig;
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
	const resolved = resolveSmartOrEoaWallet(config, deps);
	if (!resolved.ok) {
		sessions.delete(sessionId);
		// Only surface a diagnostic when the user tried to configure a wallet.
		return config.walletPrivateKey !== undefined ||
			config.smartWallet !== undefined ||
			deps.env?.X402_WALLET_KEY ||
			process.env.X402_WALLET_KEY
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
	// Autofund: check + top up the wallet in the background (never blocks
	// session start; failures land in the ledger as observed events).
	const funding = resolveFunding(config.funding);
	if (funding) {
		void runAutofund(resolved.signer, resolved.address, funding, ledger);
	}
	return undefined;
}

/** Build per-chain drivers from the funding wallet and run one autofund pass. */
async function runAutofund(
	signer: Signer,
	address: string,
	funding: NonNullable<ReturnType<typeof resolveFunding>>,
	ledger: Ledger,
): Promise<void> {
	const drivers: Partial<Record<"base" | "mainnet", ReturnType<typeof ethersDriver>>> = {};
	for (const chain of ["base", "mainnet"] as const) {
		const rpcUrl = funding.rpcUrls[chain];
		if (!rpcUrl) continue;
		const provider = new JsonRpcProvider(rpcUrl, CHAINS[chain].chainId);
		drivers[chain] = ethersDriver(signer, provider, CHAINS[chain].chainId, address);
	}
	try {
		const report = await autofund({ targetAddress: address, drivers, config: funding.config });
		if (report.needed) {
			ledger.record({
				host: "autofund",
				path: "",
				outcome: "observed",
				usdc: Number(report.targetBalanceAfter - report.targetBalanceBefore) / 1_000_000,
			});
		}
	} catch {
		// Funding failures never surface to the session; the wallet stays as-is.
	}
}

/** Resolve the session's payment wallet: the configured smart wallet (its
 *  owner key resolved with the same literal/`$VAR`/`!command` syntax) takes
 *  precedence over a plain EOA key. */
function resolveSmartOrEoaWallet(
	config: PaymentsConfig,
	deps: {
		env?: Record<string, string | undefined>;
		exec?: (command: string) => string;
	},
): { ok: true; signer: Signer; address: string } | { ok: false; reason: string } {
	if (config.smartWallet) {
		const owner = resolveWallet(config.smartWallet.ownerKey, deps);
		if (!owner.ok) return { ok: false, reason: `smart wallet owner key: ${owner.reason}` };
		// The owner signs; the smart wallet is the payment address. Base is
		// the default chain (the x402 rail).
		const ownerKey = (owner.signer as { privateKey?: string }).privateKey;
		if (typeof ownerKey !== "string") {
			return { ok: false, reason: "smart wallet owner key is not a raw private key" };
		}
		const chainId = config.smartWallet.chainId ?? 8453;
		const scheme = schemeFor(config.smartWallet.scheme, ownerKey);
		if (!scheme) {
			return { ok: false, reason: `unknown smart wallet scheme ${config.smartWallet.scheme}` };
		}
		const signer = new SmartWalletSigner(config.smartWallet.address, ownerKey, chainId, undefined, scheme);
		return { ok: true, signer, address: config.smartWallet.address };
	}
	return resolveWallet(config.walletPrivateKey, deps);
}

/** Resolve the named scheme; the PQ scheme needs an external signer plug-in
 *  (not configurable from a file), so it is not selectable here. */
function schemeFor(
	name: "safe-message" | "ecdsa-bare" | "slhdsa-raw" | undefined,
	ownerKey: string,
): WalletScheme | undefined {
	if (name === undefined || name === "safe-message") return safeMessageScheme(new SigningKey(ownerKey));
	if (name === "ecdsa-bare") return ecdsaBareScheme(new SigningKey(ownerKey));
	// slhdsa-raw needs a caller-provided PQ signer; a raw key cannot produce it.
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
