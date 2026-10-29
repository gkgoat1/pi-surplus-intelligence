/**
 * Circle CCTP bridging (mainnet USDC → Base USDC) for funding route B.
 *
 * Flow: ERC-20 approve → TokenMessenger.depositForBurn → extract the
 * MessageSent event from the burn receipt → poll the Iris attestation API
 * until complete → MessageTransmitter.receiveMessage on the destination
 * chain. Anyone may relay the receive; the mint recipient is baked into the
 * message, so the receive signer only pays destination gas.
 */
import { Interface, keccak256, getAddress } from "ethers";

import { CHAINS, type ChainDriver, type ChainRef, type TxRequest, type TxReceipt } from "./types.ts";

const ERC20 = new Interface(["function approve(address spender, uint256 amount) returns (bool)"]);
const TOKEN_MESSENGER = new Interface([
	"function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) returns (uint64 nonce)",
]);
const MESSAGE_TRANSMITTER = new Interface([
	"function receiveMessage(bytes message, bytes attestation) returns (bool success)",
]);

/** keccak256("MessageSent(bytes)") — the MessageTransmitter event topic. */
const MESSAGE_SENT_TOPIC = keccak256(new TextEncoder().encode("MessageSent(bytes)"));

/** Approve the TokenMessenger to pull `amountAtomic` USDC from the sender. */
export function buildApproveTx(chain: ChainRef, amountAtomic: bigint): TxRequest {
	const contracts = CHAINS[chain];
	if (!contracts.tokenMessenger) throw new Error(`no CCTP on ${chain}`);
	return {
		to: contracts.usdc,
		data: ERC20.encodeFunctionData("approve", [contracts.tokenMessenger, amountAtomic]),
	};
}

/** Burn `amountAtomic` USDC for minting to `mintRecipient` on the destination domain. */
export function buildDepositForBurnTx(
	chain: ChainRef,
	amountAtomic: bigint,
	mintRecipient: string,
	destinationDomain: number,
): TxRequest {
	const contracts = CHAINS[chain];
	if (!contracts.tokenMessenger) throw new Error(`no CCTP on ${chain}`);
	const recipientBytes32 = "0x" + getAddress(mintRecipient).toLowerCase().replace(/^0x/, "").padStart(64, "0");
	return {
		to: contracts.tokenMessenger,
		data: TOKEN_MESSENGER.encodeFunctionData("depositForBurn", [
			amountAtomic,
			destinationDomain,
			recipientBytes32,
			contracts.usdc,
		]),
	};
}

/** Build the destination-chain receive call. */
export function buildReceiveMessageTx(chain: ChainRef, message: string, attestation: string): TxRequest {
	const contracts = CHAINS[chain];
	if (!contracts.messageTransmitter) throw new Error(`no CCTP on ${chain}`);
	return {
		to: contracts.messageTransmitter,
		data: MESSAGE_TRANSMITTER.encodeFunctionData("receiveMessage", [message, attestation]),
	};
}

/**
 * Extract the CCTP message from a depositForBurn receipt: the MessageSent
 * event's `message` bytes and its keccak (the attestation lookup key).
 */
export function messageFromReceipt(receipt: TxReceipt): { message: string; messageHash: string } {
	for (const log of receipt.logs) {
		if (log.topics[0]?.toLowerCase() !== MESSAGE_SENT_TOPIC.toLowerCase()) continue;
		// Event is non-indexed: data = abi.encode(bytes message).
		const decoded = new Interface(["event MessageSent(bytes message)"]).decodeEventLog(
			"MessageSent",
			log.data,
			log.topics,
		);
		const message = decoded[0] as string;
		return { message, messageHash: keccak256(message) };
	}
	throw new Error("no MessageSent event in the burn receipt");
}

export type Attestation =
	| { status: "complete"; message: string; attestation: string }
	| { status: "pending_confirmations" | "pending" };

/** One attestation lookup against the Circle Iris API. */
export async function fetchAttestation(
	messageHash: string,
	fetchFn: typeof fetch = fetch,
	baseUrl = "https://iris-api.circle.com",
): Promise<Attestation> {
	const response = await fetchFn(`${baseUrl}/attestations/${messageHash}`);
	if (!response.ok) return { status: "pending" };
	const body = (await response.json()) as Record<string, unknown>;
	if (body.status === "complete" && typeof body.message === "string" && typeof body.attestation === "string") {
		return { status: "complete", message: body.message, attestation: body.attestation };
	}
	return { status: "pending" };
}

/**
 * Bridge mainnet USDC to the x402 wallet on Base: approve → burn → attest →
 * receive. `destinationDriver` pays the Base gas for the receive; the burn
 * and approve are driven by `sourceDriver` (the funder on mainnet).
 */
export async function bridgeToBase(options: {
	sourceDriver: ChainDriver;
	destinationDriver: ChainDriver;
	amountAtomic: bigint;
	recipient: string;
	pollIntervalMs?: number;
	attestationTimeoutMs?: number;
	fetchFn?: typeof fetch;
}): Promise<{ ok: boolean; txs: string[]; error?: string }> {
	const {
		sourceDriver,
		destinationDriver,
		amountAtomic,
		recipient,
		pollIntervalMs = 15_000,
		attestationTimeoutMs = 20 * 60_000,
		fetchFn = fetch,
	} = options;
	const txs: string[] = [];
	try {
		const approveHash = await sourceDriver.sendTransaction(buildApproveTx("mainnet", amountAtomic));
		txs.push(approveHash);
		const approveReceipt = await sourceDriver.waitForTransaction(approveHash);
		if (approveReceipt.status !== 1) return { ok: false, txs, error: `approve reverted (${approveHash})` };

		const burnHash = await sourceDriver.sendTransaction(
			buildDepositForBurnTx("mainnet", amountAtomic, recipient, CHAINS.base.cctpDomain!),
		);
		txs.push(burnHash);
		const burnReceipt = await sourceDriver.waitForTransaction(burnHash);
		if (burnReceipt.status !== 1) return { ok: false, txs, error: `depositForBurn reverted (${burnHash})` };

		const { messageHash } = messageFromReceipt(burnReceipt);
		const deadline = Date.now() + attestationTimeoutMs;
		for (;;) {
			const attestation = await fetchAttestation(messageHash, fetchFn);
			if (attestation.status === "complete") {
				const receiveHash = await destinationDriver.sendTransaction(
					buildReceiveMessageTx("base", attestation.message, attestation.attestation),
				);
				txs.push(receiveHash);
				const receiveReceipt = await destinationDriver.waitForTransaction(receiveHash);
				if (receiveReceipt.status !== 1) return { ok: false, txs, error: `receiveMessage reverted (${receiveHash})` };
				return { ok: true, txs };
			}
			if (Date.now() >= deadline) return { ok: false, txs, error: "attestation timed out" };
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
	} catch (error) {
		return { ok: false, txs, error: error instanceof Error ? error.message : String(error) };
	}
}
