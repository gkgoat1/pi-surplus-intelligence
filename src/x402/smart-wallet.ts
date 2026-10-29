/**
 * Smart contract wallet support for x402 (plan: gkgoat-worker docs/plans/
 * x402-autofund-vm-relay-plan.md).
 *
 * USDC's EIP-3009 `transferWithAuthorization` validates the payer's signature
 * via OpenZeppelin `SignatureChecker.isValidSignatureNow`, which accepts
 * **ERC-1271 contract signatures** — so a smart wallet can be the `from` of
 * an x402 payment when the signature validates under the wallet's
 * `isValidSignature`.
 *
 * This module implements the Safe (Safe{Wallet}) flavor, the standard smart
 * wallet: for a 32-byte digest `d`, the Safe's ERC-1271 check computes
 * `safeMessageHash = EIP-712({chainId, verifyingContract: wallet},
 * SafeMessage(bytes message = abi.encode(d)))` and ECDSA-recovers the owner
 * over it (v = 27/28). Because `abi.encode(bytes32)` is the digest itself,
 * one construction serves both the 1.3.0 `isValidSignature(bytes,bytes)` and
 * 1.4.1 `isValidSignature(bytes32,bytes)` variants. The provided signer must
 * be a valid owner of the wallet ("provided a valid signer for that wallet").
 *
 * `sendTransaction` routes through the wallet's `execTransaction` with an
 * owner-signed safeTxHash, submitted by the owner EOA (which pays gas). Only
 * single-call, operation=call, zero gas-abstraction fields are supported —
 * the funding swap/bridge calls are exactly that shape.
 */
import {
	AbstractSigner,
	Interface,
	SigningKey,
	TypedDataEncoder,
	computeAddress,
	getAddress,
	hexlify,
	keccak256,
	resolveAddress,
	toBeHex,
	type Provider,
	type TransactionRequest,
	type TypedDataDomain,
	type TypedDataField,
} from "ethers";

/** EIP-712 type for Safe's SafeMessage(bytes message). */
export const SAFE_MESSAGE_TYPES: Record<string, TypedDataField[]> = {
	SafeMessage: [{ name: "message", type: "bytes" }],
};

/** EIP-712 type for Safe's execTransaction payload hash. */
export const SAFE_TX_TYPES: Record<string, TypedDataField[]> = {
	SafeTx: [
		{ name: "to", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "data", type: "bytes" },
		{ name: "operation", type: "uint8" },
		{ name: "safeTxGas", type: "uint256" },
		{ name: "baseGas", type: "uint256" },
		{ name: "gasPrice", type: "uint256" },
		{ name: "gasToken", type: "address" },
		{ name: "refundReceiver", type: "address" },
		{ name: "nonce", type: "uint256" },
	],
};

const SAFE_IFACE = new Interface([
	"function nonce() view returns (uint256)",
	"function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool success)",
]);

/** keccak("SafeMessage(bytes message)") — exported for tests. */
export const SAFE_MSG_TYPEHASH = TypedDataEncoder.hashStruct("SafeMessage", SAFE_MESSAGE_TYPES, {
	message: "0x",
});

function ecdsaSerialized(signingKey: SigningKey, digest: string): string {
	const sig = signingKey.sign(digest);
	// eth_sign flavor: v = 27/28 (Safe recovers the digest directly).
	return `0x${sig.r.slice(2)}${sig.s.slice(2)}${sig.yParity === 0 ? "1b" : "1c"}`;
}

export class SmartWalletSigner extends AbstractSigner {
	readonly walletAddress: string;
	readonly ownerKey: SigningKey;
	readonly ownerAddress: string;
	readonly chainId: number;

	constructor(walletAddress: string, ownerPrivateKey: string, chainId: number, provider?: Provider) {
		super(provider);
		this.walletAddress = getAddress(walletAddress);
		this.ownerKey = new SigningKey(ownerPrivateKey);
		this.ownerAddress = computeAddress(this.ownerKey.publicKey);
		this.chainId = chainId;
	}

	override async getAddress(): Promise<string> {
		return this.walletAddress;
	}

	override connect(provider: Provider): SmartWalletSigner {
		return new SmartWalletSigner(this.walletAddress, this.ownerKey.privateKey, this.chainId, provider);
	}

	/** The Safe ERC-1271 message hash for a 32-byte digest (see module doc). */
	safeMessageHash(digest: string): string {
		return TypedDataEncoder.hash(
			{ chainId: this.chainId, verifyingContract: this.walletAddress },
			SAFE_MESSAGE_TYPES,
			{ message: digest },
		);
	}

	/**
	 * Sign typed data as the smart wallet: the returned signature validates
	 * under the wallet's ERC-1271 `isValidSignature` for the EIP-712 digest.
	 */
	override async signTypedData(
		domain: TypedDataDomain,
		types: Record<string, TypedDataField[]>,
		value: Record<string, unknown>,
	): Promise<string> {
		const digest = TypedDataEncoder.hash(domain, types, value);
		return ecdsaSerialized(this.ownerKey, this.safeMessageHash(digest));
	}

	/** Personal-message signing as the smart wallet (same ERC-1271 wrap). */
	override async signMessage(message: string | Uint8Array): Promise<string> {
		const bytes =
			typeof message === "string"
				? message.startsWith("0x")
					? message
					: hexlify(toUtf8(message))
				: hexlify(message);
		const digest = messageDigest(bytes);
		return ecdsaSerialized(this.ownerKey, this.safeMessageHash(digest));
	}

	override async signTransaction(): Promise<string> {
		throw new Error("smart wallets do not sign raw transactions; use sendTransaction (execTransaction)");
	}

	/**
	 * Execute through the wallet: encode execTransaction with the owner's
	 * safeTxHash signature, submitted by the owner EOA. Single call, plain
	 * CALL operation, no gas abstraction.
	 */
	override async sendTransaction(tx: TransactionRequest) {
		if (!this.provider) throw new Error("smart wallet sendTransaction needs a provider");
		const to = await resolveAddress(tx.to as string, this.provider);
		const value = tx.value !== undefined && tx.value !== null ? BigInt(tx.value.toString()) : 0n;
		const data = (tx.data as string | undefined) ?? "0x";
		const nonceRaw = await this.provider.call({
			to: this.walletAddress,
			data: SAFE_IFACE.encodeFunctionData("nonce", []),
		});
		const nonce = BigInt(nonceRaw);
		const safeTxHash = TypedDataEncoder.hash(
			{ chainId: this.chainId, verifyingContract: this.walletAddress },
			SAFE_TX_TYPES,
			{
				to,
				value,
				data,
				operation: 0,
				safeTxGas: 0n,
				baseGas: 0n,
				gasPrice: 0n,
				gasToken: "0x0000000000000000000000000000000000000000",
				refundReceiver: "0x0000000000000000000000000000000000000000",
				nonce,
			},
		);
		const signature = ecdsaSerialized(this.ownerKey, safeTxHash);
		const owner = this.ownerKey;
		// The owner EOA submits (it pays gas); the call itself is the Safe's.
		const { Wallet } = await import("ethers");
		const ownerWallet = new Wallet(owner.privateKey, this.provider);
		return ownerWallet.sendTransaction({
			to: this.walletAddress,
			data: SAFE_IFACE.encodeFunctionData("execTransaction", [
				to,
				toBeHex(value),
				data,
				0,
				0n,
				0n,
				0n,
				"0x0000000000000000000000000000000000000000",
				"0x0000000000000000000000000000000000000000",
				signature,
			]),
		});
	}
}

function toUtf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function messageDigest(bytes: string): string {
	// eth_sign message digest: keccak256("\x19Ethereum Signed Message:\n" + len + message).
	const raw = bytes.startsWith("0x") ? bytes.slice(2) : bytes;
	const length = raw.length / 2;
	const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${length}`);
	const body = new Uint8Array(raw.length / 2);
	for (let i = 0; i < body.length; i++) body[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
	const combined = new Uint8Array(prefix.length + body.length);
	combined.set(prefix, 0);
	combined.set(body, prefix.length);
	return keccak256(combined);
}

/** True when `address` is a contract on `provider` (has code) — i.e. a smart wallet. */
export async function isContractWallet(provider: Provider, address: string): Promise<boolean> {
	return (await provider.getCode(address)) !== "0x";
}
