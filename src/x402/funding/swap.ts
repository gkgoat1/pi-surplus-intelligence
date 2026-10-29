/**
 * Uniswap V3 single-hop ETH→USDC swaps for x402 wallet funding.
 *
 * The SwapRouter02 `exactInputSingle` call carries the ETH as msg.value with
 * tokenIn = WETH (the router wraps it). Quotes come from QuoterV2's
 * `quoteExactInputSingle` via eth_call (it is intentionally non-view and
 * revert-based internally, but returns the quote when called statically).
 * All calldata is built with ethers ABI utilities already present in the
 * repo — no new dependencies.
 */
import { AbiCoder, Interface, getAddress } from "ethers";

import { CHAINS, type ChainDriver, type ChainRef, type TxRequest } from "./types.ts";

const coder = AbiCoder.defaultAbiCoder();

// Selector: exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
const SWAP_IFACE = new Interface([
	"function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);
// Selector: quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)
const QUOTER_IFACE = new Interface([
	"function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

/** Build the swap transaction: `amountInWei` of native ETH → USDC to `recipient`. */
export function buildSwapTx(chain: ChainRef, recipient: string, amountInWei: bigint, amountOutMinimum: bigint): TxRequest {
	const contracts = CHAINS[chain];
	const data = SWAP_IFACE.encodeFunctionData("exactInputSingle", [
		{
			tokenIn: contracts.weth,
			tokenOut: contracts.usdc,
			fee: contracts.poolFee,
			recipient: getAddress(recipient),
			amountIn: amountInWei,
			amountOutMinimum,
			sqrtPriceLimitX96: 0n,
		},
	]);
	return { to: contracts.swapRouter02, data, valueWei: amountInWei };
}

/**
 * Quote the USDC out for `amountInWei` of ETH via QuoterV2 (eth_call).
 * Throws when the quote fails (no liquidity / bad pool).
 */
export async function quoteSwap(driver: ChainDriver, chain: ChainRef, amountInWei: bigint): Promise<bigint> {
	const contracts = CHAINS[chain];
	const data = QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [
		{
			tokenIn: contracts.weth,
			tokenOut: contracts.usdc,
			amountIn: amountInWei,
			fee: contracts.poolFee,
			sqrtPriceLimitX96: 0n,
		},
	]);
	const returned = await driver.call({ to: contracts.quoterV2, data });
	const decoded = coder.decode(["uint256"], returned);
	return decoded[0] as bigint;
}

/** Quote with the slippage margin applied (basis points, e.g. 50 = 0.5%). */
export async function quoteWithSlippage(
	driver: ChainDriver,
	chain: ChainRef,
	amountInWei: bigint,
	slippageBps: number,
): Promise<bigint> {
	const quoted = await quoteSwap(driver, chain, amountInWei);
	return (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
}

export type SwapBatchResult = {
	ok: boolean;
	/** USDC gained across all executed batches (atomic). */
	gainedAtomic: bigint;
	txs: string[];
	/** Set on the first failing batch. */
	error?: string;
};

/**
 * Execute a swap plan in batches: `batches` swaps of `batchWei` each,
 * sequentially, recipient fixed. The first failing batch stops the route —
 * the caller falls through to the next route.
 */
export async function executeSwapBatches(options: {
	driver: ChainDriver;
	chain: ChainRef;
	recipient: string;
	batchWei: bigint;
	batches: number;
	slippageBps: number;
}): Promise<SwapBatchResult> {
	const { driver, chain, recipient, batchWei, batches, slippageBps } = options;
	const usdc = CHAINS[chain].usdc;
	const before = await driver.getTokenBalance(usdc, recipient);
	const txs: string[] = [];
	for (let i = 0; i < batches; i++) {
		let minOut: bigint;
		try {
			minOut = await quoteWithSlippage(driver, chain, batchWei, slippageBps);
		} catch (error) {
			return { ok: false, gainedAtomic: 0n, txs, error: `quote failed: ${message(error)}` };
		}
		try {
			const hash = await driver.sendTransaction(buildSwapTx(chain, recipient, batchWei, minOut));
			const receipt = await driver.waitForTransaction(hash);
			if (receipt.status !== 1) return { ok: false, gainedAtomic: 0n, txs, error: `swap reverted (${hash})` };
			txs.push(hash);
		} catch (error) {
			return { ok: false, gainedAtomic: 0n, txs, error: `swap failed: ${message(error)}` };
		}
	}
	const after = await driver.getTokenBalance(usdc, recipient);
	return { ok: true, gainedAtomic: after - before, txs };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Re-exported for the bridge module.
export { coder as abiCoder };
