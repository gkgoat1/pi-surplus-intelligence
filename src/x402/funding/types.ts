/**
 * Chain abstraction for x402 wallet funding (plan: docs/plans/
 * x402-autofund-vm-relay-plan.md in gkgoat-worker). A ChainDriver owns the
 * JSON-RPC reads and the transaction sends for one chain; production drivers
 * wrap an ethers Signer + provider, tests script a fake. Key material never
 * appears here — the driver signs internally.
 */
import { getAddress } from "ethers";

/** One unsigned transaction the driver must sign and broadcast. */
export type TxRequest = {
	to: string;
	data: string;
	/** Native value in wei; omit/0 for a plain call-style tx. */
	valueWei?: bigint;
};

export type TxReceipt = {
	/** 1 = success, 0 = reverted. */
	status: 1 | 0;
	/** Raw logs, for CCTP MessageSent extraction. */
	logs: { address: string; topics: string[]; data: string }[];
};

export interface ChainDriver {
	chainId: number;
	/** The funding signer's own address. */
	readonly address: string;
	getNativeBalance(address: string): Promise<bigint>;
	getTokenBalance(token: string, address: string): Promise<bigint>;
	/** eth_call; returns the 0x-prefixed return data. */
	call(tx: TxRequest): Promise<string>;
	sendTransaction(tx: TxRequest): Promise<string>;
	waitForTransaction(hash: string): Promise<TxReceipt>;
}

export type ChainRef = "base" | "mainnet";

export type ChainContracts = {
	chainId: number;
	network: string;
	usdc: string;
	weth: string;
	swapRouter02: string;
	quoterV2: string;
	/** Uniswap V3 pool fee tier for the WETH/USDC pool (500 = 0.05%). */
	poolFee: number;
	/** Circle CCTP contracts; undefined on chains without CCTP. */
	tokenMessenger?: string;
	messageTransmitter?: string;
	/** Circle CCTP domain id (Ethereum = 0, Base = 6). */
	cctpDomain?: number;
};

export const CHAINS: Record<ChainRef, ChainContracts> = {
	base: {
		chainId: 8453,
		network: "eip155:8453",
		usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
		weth: getAddress("0x4200000000000000000000000000000000000006"),
		swapRouter02: getAddress("0x2626664c2603336E57B271c5C0b26F421741e481"),
		quoterV2: getAddress("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"),
		poolFee: 500,
		tokenMessenger: getAddress("0x1682aE6375cDeEF2fCdD45187be3bEbAe21BCb0b"),
		messageTransmitter: getAddress("0xAD09780d6e9Ce2bcf81b1776Cbb30B5188BD08BC"),
		cctpDomain: 6,
	},
	mainnet: {
		chainId: 1,
		network: "eip155:1",
		usdc: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
		weth: getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
		swapRouter02: getAddress("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"),
		quoterV2: getAddress("0x61fFE014bA17989E743c5F6cB21bF9697530B21e"),
		poolFee: 500,
		tokenMessenger: getAddress("0xBd3fa81B58Ba92a82136038B25aDec7066af3155"),
		messageTransmitter: getAddress("0x0a992d191DEeC32aFe36203Ad87D7d289a738F81"),
		cctpDomain: 0,
	},
};
