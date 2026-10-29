/**
 * Autofund orchestration (plan: gkgoat-worker docs/plans/
 * x402-autofund-vm-relay-plan.md). When the x402 wallet's USDC on Base drops
 * below `minUsdc`, fund it to `targetUsdc` by trying each route in order:
 *
 * - **base**: swap ETH→USDC on Base in batches, recipient = the x402 wallet.
 *   Requires the funder to hold ETH on Base.
 * - **mainnet**: swap ETH→USDC on mainnet in batches (recipient = funder),
 *   then CCTP-bridge the proceeds to the x402 wallet on Base. Requires ETH
 *   on mainnet plus a Base gas payer for the receive.
 *
 * Each route executes in batches; a failed batch ends that route and the
 * planner falls through. Every attempt is reported on the returned record —
 * funding failures never throw past the caller.
 */
import { bridgeToBase } from "./bridge.ts";
import { executeSwapBatches } from "./swap.ts";
import { CHAINS, type ChainDriver, type ChainRef } from "./types.ts";

export type FundingConfig = {
	/** Trigger threshold: fund when Base USDC (atomic) is below this. */
	minUsdcAtomic: bigint;
	/** Fund up to this Base USDC (atomic). */
	targetUsdcAtomic: bigint;
	/** ETH per swap batch (wei). */
	batchWei: bigint;
	/** Max batches per route attempt. */
	maxBatches: number;
	/** Slippage margin for the quote (basis points). */
	slippageBps: number;
	/** Route order; defaults to base then mainnet. */
	routeOrder: ChainRef[];
};

export const DEFAULT_FUNDING_CONFIG: FundingConfig = {
	minUsdcAtomic: 1_000_000n, // $1
	targetUsdcAtomic: 10_000_000n, // $10
	batchWei: 5_000_000_000_000_000n, // 0.005 ETH per batch
	maxBatches: 4,
	slippageBps: 100, // 1%
	routeOrder: ["base", "mainnet"],
};

export type RouteAttempt = {
	route: ChainRef;
	ok: boolean;
	gainedAtomic: bigint;
	txs: string[];
	error?: string;
};

export type FundingReport = {
	needed: boolean;
	targetBalanceBefore: bigint;
	targetBalanceAfter: bigint;
	attempts: RouteAttempt[];
};

export type AutofundDeps = {
	/** The x402 wallet being funded. */
	targetAddress: string;
	drivers: Partial<Record<ChainRef, ChainDriver>>;
	config?: Partial<FundingConfig>;
	/** For CCTP attestation polling. */
	fetchFn?: typeof fetch;
	attestationTimeoutMs?: number;
};

/**
 * Check the target's Base USDC and fund it if below the threshold. The Base
 * driver is mandatory (balance reads + route A + the CCTP receive); the
 * mainnet driver enables route B.
 */
export async function autofund(deps: AutofundDeps): Promise<FundingReport> {
	const config: FundingConfig = { ...DEFAULT_FUNDING_CONFIG, ...deps.config };
	const base = deps.drivers.base;
	if (!base) throw new Error("autofund requires a Base chain driver");

	const before = await base.getTokenBalance(CHAINS.base.usdc, deps.targetAddress);
	const report: FundingReport = {
		needed: before < config.minUsdcAtomic,
		targetBalanceBefore: before,
		targetBalanceAfter: before,
		attempts: [],
	};
	if (!report.needed) return report;

	for (const route of config.routeOrder) {
		if (route === "base") {
			report.attempts.push(await runBaseRoute(base, deps.targetAddress, config));
		} else {
			report.attempts.push(await runMainnetRoute(base, deps.drivers.mainnet, deps.targetAddress, config, deps));
		}
		const after = await base.getTokenBalance(CHAINS.base.usdc, deps.targetAddress);
		report.targetBalanceAfter = after;
		if (after >= config.targetUsdcAtomic) return report;
	}
	return report;
}

async function runBaseRoute(
	base: ChainDriver,
	target: string,
	config: FundingConfig,
): Promise<RouteAttempt> {
	const eth = await base.getNativeBalance(base.address);
	// Reserve ~0.0002 ETH for gas; swap the rest in batches.
	const spendable = ethMinusGasReserve(eth);
	if (spendable < config.batchWei) {
		return { route: "base", ok: false, gainedAtomic: 0n, txs: [], error: "insufficient ETH on Base" };
	}
	const batches = Math.min(config.maxBatches, Number(spendable / config.batchWei));
	const result = await executeSwapBatches({
		driver: base,
		chain: "base",
		recipient: target,
		batchWei: config.batchWei,
		batches,
		slippageBps: config.slippageBps,
	});
	return { route: "base", ok: result.ok, gainedAtomic: result.gainedAtomic, txs: result.txs, ...(result.error ? { error: result.error } : {}) };
}

async function runMainnetRoute(
	base: ChainDriver,
	mainnet: ChainDriver | undefined,
	target: string,
	config: FundingConfig,
	deps: AutofundDeps,
): Promise<RouteAttempt> {
	if (!mainnet) {
		return { route: "mainnet", ok: false, gainedAtomic: 0n, txs: [], error: "no mainnet driver configured" };
	}
	const eth = await mainnet.getNativeBalance(mainnet.address);
	const spendable = ethMinusGasReserve(eth);
	if (spendable < config.batchWei) {
		return { route: "mainnet", ok: false, gainedAtomic: 0n, txs: [], error: "insufficient ETH on mainnet" };
	}
	const batches = Math.min(config.maxBatches, Number(spendable / config.batchWei));
	// Swap on mainnet with the FUNDER as recipient, then bridge the proceeds.
	const swapped = await executeSwapBatches({
		driver: mainnet,
		chain: "mainnet",
		recipient: mainnet.address,
		batchWei: config.batchWei,
		batches,
		slippageBps: config.slippageBps,
	});
	if (!swapped.ok || swapped.gainedAtomic === 0n) {
		return { route: "mainnet", ok: false, gainedAtomic: swapped.gainedAtomic, txs: swapped.txs, ...(swapped.error ? { error: swapped.error } : {}) };
	}
	const bridged = await bridgeToBase({
		sourceDriver: mainnet,
		destinationDriver: base,
		amountAtomic: swapped.gainedAtomic,
		recipient: target,
		...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
		...(deps.attestationTimeoutMs !== undefined ? { attestationTimeoutMs: deps.attestationTimeoutMs } : {}),
	});
	return {
		route: "mainnet",
		ok: bridged.ok,
		gainedAtomic: bridged.ok ? swapped.gainedAtomic : 0n,
		txs: [...swapped.txs, ...bridged.txs],
		...(bridged.error ? { error: bridged.error } : {}),
	};
}

/** Gas reserve: keep 0.0005 ETH for the route's own transactions. */
function ethMinusGasReserve(balance: bigint): bigint {
	const reserve = 500_000_000_000_000n; // 0.0005 ETH
	return balance > reserve ? balance - reserve : 0n;
}
