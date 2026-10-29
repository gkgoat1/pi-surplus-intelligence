/**
 * Funding module tests (plan: gkgoat-worker docs/plans/
 * x402-autofund-vm-relay-plan.md). A scripted FakeChainDriver simulates the
 * chain: balances, quoter eth_calls, swap/burn/receive side effects. No
 * network, no keys.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, Interface, keccak256 } from "ethers";

import { autofund, DEFAULT_FUNDING_CONFIG } from "../src/x402/funding/autofund.ts";
import { buildSwapTx, quoteWithSlippage } from "../src/x402/funding/swap.ts";
import { buildDepositForBurnTx, messageFromReceipt } from "../src/x402/funding/bridge.ts";
import { CHAINS, type ChainDriver, type TxRequest, type TxReceipt } from "../src/x402/funding/types.ts";

const coder = AbiCoder.defaultAbiCoder();
const FUNDER = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";
// Fake rate: 1 wei of ETH → 4000 "USDC atomic" so batch math is legible.
const FAKE_RATE = 4000n;

type FakeState = {
	nativeWei: bigint;
	usdcByAddress: Map<string, bigint>;
	quoteOut: bigint;
	failNextSend: boolean;
	txs: TxRequest[];
	burnReceipt: TxReceipt | undefined;
	/** What a Base receiveMessage credits the target (the bridged amount). */
	creditOnReceiveAtomic: bigint;
};

function fakeDriver(chain: "base" | "mainnet", state: FakeState): ChainDriver {
	const contracts = CHAINS[chain];
	const usdc = contracts.usdc.toLowerCase();
	const balanceOf = (token: string, address: string) =>
		token.toLowerCase() === usdc ? (state.usdcByAddress.get(address.toLowerCase()) ?? 0n) : 0n;
	return {
		chainId: contracts.chainId,
		address: FUNDER,
		getNativeBalance: async (address) => (address.toLowerCase() === FUNDER.toLowerCase() ? state.nativeWei : 0n),
		getTokenBalance: async (token, address) => balanceOf(token, address),
		call: async (tx) => {
			if (tx.to.toLowerCase() === contracts.quoterV2.toLowerCase()) {
				return coder.encode(["uint256", "uint160", "uint32", "uint256"], [state.quoteOut, 0n, 0, 21_000n]);
			}
			if (tx.data.startsWith("0x70a08231")) {
				const address = "0x" + tx.data.slice(-40);
				return coder.encode(["uint256"], [balanceOf(usdc, address)]);
			}
			throw new Error(`unexpected eth_call to ${tx.to}`);
		},
		sendTransaction: async (tx) => {
			if (state.failNextSend) {
				state.failNextSend = false;
				throw new Error("simulated send failure");
			}
			state.txs.push(tx);
			// Swap: valueWei of ETH becomes quoteOut USDC at the recipient.
			const swapInterface = 			new Interface([
				"function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable",
			]);
			if (tx.data.startsWith(swapInterface.getFunction("exactInputSingle")!.selector)) {
				state.nativeWei -= tx.valueWei!;
				const decoded = swapInterface.decodeFunctionData("exactInputSingle", tx.data);
				const recipient = (decoded[0] as { recipient: string }).recipient.toLowerCase();
				state.usdcByAddress.set(recipient, (state.usdcByAddress.get(recipient) ?? 0n) + state.quoteOut);
			}
			// depositForBurn: synthesize a MessageSent receipt log.
			if (tx.to.toLowerCase() === contracts.tokenMessenger?.toLowerCase()) {
				const message = coder.encode(["uint32", "bytes32"], [6, keccak256("0x1234")]);
				state.burnReceipt = {
					status: 1,
					logs: [
						{
							address: contracts.messageTransmitter!,
							topics: [keccak256(new TextEncoder().encode("MessageSent(bytes)"))],
							data: coder.encode(["bytes"], [message]),
						},
					],
				};
			}
			// receiveMessage on Base: credit the mint recipient with the
			// bridged amount (the real message encodes it; the fake is told it).
			if (tx.to.toLowerCase() === CHAINS.base.messageTransmitter!.toLowerCase() && chain === "base") {
				state.usdcByAddress.set(
					TARGET.toLowerCase(),
					(state.usdcByAddress.get(TARGET.toLowerCase()) ?? 0n) + state.creditOnReceiveAtomic,
				);
			}
			return "0x" + "ab".repeat(32);
		},
		waitForTransaction: async () => state.burnReceipt ?? { status: 1, logs: [] },
	};
}

function fakeState(overrides: Partial<FakeState> = {}): FakeState {
	return {
		nativeWei: 0n,
		usdcByAddress: new Map(),
		quoteOut: 100n,
		failNextSend: false,
		txs: [],
		burnReceipt: undefined,
		creditOnReceiveAtomic: 0n,
		...overrides,
	};
}

test("buildSwapTx encodes exactInputSingle with WETH→USDC and the value", () => {
	const tx = buildSwapTx("base", TARGET, 1_000_000_000_000_000n, 950n);
	assert.equal(tx.to, CHAINS.base.swapRouter02);
	assert.equal(tx.valueWei, 1_000_000_000_000_000n);
	const decoded = new Interface([
		"function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable",
	]).decodeFunctionData("exactInputSingle", tx.data);
	const params = decoded[0] as { tokenIn: string; tokenOut: string; fee: bigint; recipient: string };
	assert.equal(params.tokenIn, CHAINS.base.weth);
	assert.equal(params.tokenOut, CHAINS.base.usdc);
	assert.equal(params.fee, 500n);
	assert.equal(params.recipient.toLowerCase(), TARGET.toLowerCase());
});

test("quoteWithSlippage applies the bps margin", async () => {
	const state = fakeState({ quoteOut: 2_000_000n });
	const driver = fakeDriver("base", state);
	const min = await quoteWithSlippage(driver, "base", 1_000n, 100); // 1%
	assert.equal(min, 1_980_000n);
});

test("buildDepositForBurnTx encodes the recipient as bytes32", () => {
	const tx = buildDepositForBurnTx("mainnet", 5_000_000n, TARGET, CHAINS.base.cctpDomain!);
	assert.equal(tx.to, CHAINS.mainnet.tokenMessenger);
	const decoded = new Interface([
		"function depositForBurn(uint256,uint32,bytes32,address)",
	]).decodeFunctionData("depositForBurn", tx.data);
	assert.equal(decoded[0], 5_000_000n);
	assert.equal(decoded[1], 6n);
	assert.equal((decoded[2] as string).toLowerCase(), ("0x" + TARGET.slice(2).padStart(64, "0")).toLowerCase());
	assert.equal(decoded[3], CHAINS.mainnet.usdc);
});

test("messageFromReceipt extracts the CCTP message + hash", () => {
	const message = coder.encode(["uint32", "bytes32"], [6, keccak256("0x1234")]);
	const receipt: TxReceipt = {
		status: 1,
		logs: [
			{
				address: CHAINS.mainnet.messageTransmitter!,
				topics: [keccak256(new TextEncoder().encode("MessageSent(bytes)"))],
				data: coder.encode(["bytes"], [message]),
			},
		],
	};
	const extracted = messageFromReceipt(receipt);
	assert.equal(extracted.message, message);
	assert.equal(extracted.messageHash, keccak256(message));
});

test("autofund does nothing above the threshold", async () => {
	const state = fakeState();
	state.usdcByAddress.set(TARGET.toLowerCase(), 50_000_000n); // $50 > $1 min
	const driver = fakeDriver("base", state);
	const report = await autofund({ targetAddress: TARGET, drivers: { base: driver } });
	assert.equal(report.needed, false);
	assert.equal(report.attempts.length, 0);
});

test("autofund runs the base route in batches until the target is reached", async () => {
	const state = fakeState({ nativeWei: 100_000_000_000_000_000n, quoteOut: 20_000_000n }); // $20/batch
	const driver = fakeDriver("base", state);
	const report = await autofund({
		targetAddress: TARGET,
		drivers: { base: driver },
		config: { ...DEFAULT_FUNDING_CONFIG, batchWei: 5_000_000_000_000_000n, maxBatches: 2 },
	});
	assert.equal(report.needed, true);
	assert.equal(report.attempts.length, 1);
	assert.equal(report.attempts[0]!.route, "base");
	assert.equal(report.attempts[0]!.ok, true);
	// 2 batches × $20 = $40 ≥ $10 target.
	assert.equal(report.targetBalanceAfter, 40_000_000n);
});

test("autofund falls through to the mainnet route when Base ETH is missing", async () => {
	const baseState = fakeState({ nativeWei: 0n, creditOnReceiveAtomic: 20_000_000n });
	const mainState = fakeState({ nativeWei: 100_000_000_000_000_000n, quoteOut: 20_000_000n });
	const baseDriver = fakeDriver("base", baseState);
	const mainDriver = fakeDriver("mainnet", mainState);
	const report = await autofund({
		targetAddress: TARGET,
		drivers: { base: baseDriver, mainnet: mainDriver },
		config: { ...DEFAULT_FUNDING_CONFIG, batchWei: 5_000_000_000_000_000n, maxBatches: 1 },
		fetchFn: (async () =>
			new Response(JSON.stringify({ status: "complete", message: "0x12", attestation: "0x34" }), {
				status: 200,
			})) as typeof fetch,
	});
	assert.equal(report.attempts.length, 2);
	assert.equal(report.attempts[0]!.route, "base");
	assert.equal(report.attempts[0]!.ok, false);
	assert.equal(report.attempts[1]!.route, "mainnet");
	assert.equal(report.attempts[1]!.ok, true);
	// Bridge credited the target on Base via the fake receiveMessage.
	assert.equal(report.targetBalanceAfter, 20_000_000n);
});

test("autofund stops a route on the first failing batch", async () => {
	const state = fakeState({ nativeWei: 100_000_000_000_000_000n, quoteOut: 1_000_000n, failNextSend: true });
	const driver = fakeDriver("base", state);
	const report = await autofund({
		targetAddress: TARGET,
		drivers: { base: driver },
		config: { ...DEFAULT_FUNDING_CONFIG, batchWei: 5_000_000_000_000_000n, maxBatches: 3 },
	});
	assert.equal(report.attempts[0]!.ok, false);
	assert.match(report.attempts[0]!.error!, /simulated send failure/);
});
