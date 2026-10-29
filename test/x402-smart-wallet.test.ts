/**
 * Smart wallet signing tests: the SmartWalletSigner's signTypedData must
 * produce a signature that recovers to the OWNER over the Safe-style
 * SafeMessage EIP-712 hash of the original digest — exactly what the Safe's
 * ERC-1271 isValidSignature computes on-chain.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SigningKey, TypedDataEncoder, computeAddress } from "ethers";

import { SmartWalletSigner, SAFE_MESSAGE_TYPES } from "../src/x402/smart-wallet.ts";
import { EIP3009_TYPES, type PaymentRequirement } from "../src/x402/sign.ts";

const OWNER_KEY = "0x" + "0".repeat(63) + "1";
const SAFE = "0x9cA70B93CaE5576645F5F069524A9B9c3aef5006";
const CHAIN_ID = 8453;

function safeMessageHash(digest: string): string {
	return TypedDataEncoder.hash(
		{ chainId: CHAIN_ID, verifyingContract: SAFE },
		SAFE_MESSAGE_TYPES,
		{ message: digest },
	);
}

test("signTypedData returns an ERC-1271 signature recovering the owner over the SafeMessage wrap", async () => {
	const signer = new SmartWalletSigner(SAFE, OWNER_KEY, CHAIN_ID);
	assert.equal(await signer.getAddress(), SAFE);

	const domain = { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
	const value = {
		from: SAFE,
		to: "0x2f9518019575e048320c1e7da4dc4d6d8384c2c8",
		value: 10000n,
		validAfter: 0n,
		validBefore: 1_800_000_000n,
		nonce: "0x" + "ab".repeat(32),
	};
	const signature = await signer.signTypedData(domain, EIP3009_TYPES, value);

	// What the Safe's isValidSignature does: hash the digest as a SafeMessage
	// and ecrecover the owner.
	const digest = TypedDataEncoder.hash(domain, EIP3009_TYPES, value);
	const expectedMessageHash = safeMessageHash(digest);
	const r = signature.slice(0, 66);
	const s = "0x" + signature.slice(66, 130);
	const v = parseInt(signature.slice(130, 132), 16);
	assert.ok(v === 27 || v === 28, `v must be 27/28, got ${v}`);
	const recoveredAddress = SigningKey.recoverPublicKey(expectedMessageHash, { r, s, v, yParity: (v - 27) as 0 | 1 });
	assert.equal(computeAddress(recoveredAddress), computeAddress(new SigningKey(OWNER_KEY).publicKey));
});

test("the wrapped hash binds the wallet address and chain (replay protection)", async () => {
	const a = new SmartWalletSigner(SAFE, OWNER_KEY, CHAIN_ID);
	const b = new SmartWalletSigner(SAFE, OWNER_KEY, 1); // mainnet instead of Base
	const domain = { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
	const value = { from: SAFE, to: SAFE, value: 1n, validAfter: 0n, validBefore: 1n, nonce: "0x" + "00".repeat(32) };
	const sigA = await a.signTypedData(domain, EIP3009_TYPES, value);
	const sigB = await b.signTypedData(domain, EIP3009_TYPES, value);
	assert.notEqual(sigA, sigB, "different chains must yield different signatures");
});

test("signMessage wraps the eth_sign digest in the SafeMessage", async () => {
	const signer = new SmartWalletSigner(SAFE, OWNER_KEY, CHAIN_ID);
	const signature = await signer.signMessage("hello");
	// Reconstruct: eth_sign digest of "hello", then the SafeMessage hash of it.
	const ethDigest = (() => {
		const body = new TextEncoder().encode("hello");
		const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
		const combined = new Uint8Array(prefix.length + body.length);
		combined.set(prefix, 0);
		combined.set(body, prefix.length);
		return combined;
	})();
	const { keccak256 } = await import("ethers");
	const digest = keccak256(ethDigest);
	const messageHash = safeMessageHash(digest);
	const r = signature.slice(0, 66);
	const s = "0x" + signature.slice(66, 130);
	const v = parseInt(signature.slice(130, 132), 16);
	const recovered = SigningKey.recoverPublicKey(messageHash, { r, s, v, yParity: (v - 27) as 0 | 1 });
	assert.equal(computeAddress(recovered), computeAddress(new SigningKey(OWNER_KEY).publicKey));
});

test("x402 payment flow works end-to-end with the smart wallet as from", async () => {
	const signer = new SmartWalletSigner(SAFE, OWNER_KEY, CHAIN_ID);
	const { signTransferAuthorization } = await import("../src/x402/sign.ts");
	const requirement: PaymentRequirement = {
		scheme: "exact",
		network: "eip155:8453",
		asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		amount: "10000",
		payTo: "0x2f9518019575e048320c1e7da4dc4d6d8384c2c8",
		maxTimeoutSeconds: 600,
	};
	const signed = await signTransferAuthorization(signer, requirement, { nowSeconds: 1_800_000_000 });
	assert.equal(signed.authorization.from, SAFE);
	// The on-chain check (SignatureChecker → Safe.isValidSignature) would:
	const digest = TypedDataEncoder.hash(
		{ name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: requirement.asset },
		EIP3009_TYPES,
		{
			from: signed.authorization.from,
			to: signed.authorization.to,
			value: BigInt(signed.authorization.value),
			validAfter: 0n,
			validBefore: BigInt(signed.authorization.validBefore),
			nonce: signed.authorization.nonce,
		},
	);
	const messageHash = safeMessageHash(digest);
	const signature = signed.signature;
	const r = signature.slice(0, 66);
	const s = "0x" + signature.slice(66, 130);
	const v = parseInt(signature.slice(130, 132), 16);
	const recovered = SigningKey.recoverPublicKey(messageHash, { r, s, v, yParity: (v - 27) as 0 | 1 });
	assert.equal(computeAddress(recovered), computeAddress(new SigningKey(OWNER_KEY).publicKey));
});

test("isContractWallet is a code check", async () => {
	const { isContractWallet } = await import("../src/x402/smart-wallet.ts");
	const fakeProvider = {
		getCode: async (address: string) => (address === SAFE ? "0x6080" : "0x"),
	} as never;
	assert.equal(await isContractWallet(fakeProvider as never, SAFE), true);
	assert.equal(await isContractWallet(fakeProvider as never, "0x2f9518019575e048320c1e7da4dc4d6d8384c2c8"), false);
});
