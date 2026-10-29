/**
 * Convert the `payments.funding` file config (dollars / ETH units) into the
 * runtime FundingConfig (atomic units). Returns undefined when funding is
 * disabled or unusable — autofunding simply stays off.
 */
import type { FundingFileConfig } from "../../provider-config.ts";
import { DEFAULT_FUNDING_CONFIG, type FundingConfig } from "./autofund.ts";
import type { ChainRef } from "./types.ts";

const USDC_DECIMALS = 6n;
const WEI_PER_ETH = 1_000_000_000_000_000_000n;

/** Dollars → USDC atomic units (6 decimals); float-safe to the cent. */
export function usdcToAtomic(usdc: number): bigint {
	return BigInt(Math.round(usdc * 1_000_000)) * 10n ** (USDC_DECIMALS - 6n);
}

/** ETH → wei; float-safe to 1e-9 ETH (gwei precision). */
export function ethToWei(eth: number): bigint {
	return BigInt(Math.round(eth * 1e9)) * (WEI_PER_ETH / 10n ** 9n);
}

export type ResolvedFunding = {
	config: FundingConfig;
	rpcUrls: { base?: string; mainnet?: string };
};

export function resolveFunding(file: FundingFileConfig | undefined): ResolvedFunding | undefined {
	if (!file || file.enabled !== true) return undefined;
	const config: FundingConfig = { ...DEFAULT_FUNDING_CONFIG };
	if (file.minUsdc !== undefined) config.minUsdcAtomic = usdcToAtomic(file.minUsdc);
	if (file.targetUsdc !== undefined) config.targetUsdcAtomic = usdcToAtomic(file.targetUsdc);
	if (file.batchEth !== undefined) config.batchWei = ethToWei(file.batchEth);
	if (file.maxBatches !== undefined) config.maxBatches = file.maxBatches;
	if (file.slippageBps !== undefined) config.slippageBps = file.slippageBps;
	if (file.routeOrder !== undefined) config.routeOrder = file.routeOrder as ChainRef[];
	if (config.targetUsdcAtomic <= config.minUsdcAtomic) return undefined;
	if (config.batchWei <= 0n) return undefined;
	return { config, rpcUrls: file.rpcUrls ?? {} };
}
