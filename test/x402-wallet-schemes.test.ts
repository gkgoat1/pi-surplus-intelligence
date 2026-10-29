/**
 * Wallet-scheme registry tests: the pluggable signature schemes and the
 * on-chain validity pre-check (the canary). Schemes are arbitrary, so the
 * pre-check is the trust gate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SigningKey, TypedDataEncoder, computeAddress } from "ethers";

import {
	CANARY_DIGEST,
	ERC1271_MAGIC,
	assertSchemeValid,
	createSchemeRegistry,
	ecdsaBareScheme,
	erc1271Call,
	safeMessageScheme,
	slhDsaRawScheme,
	supportsErc1271Call,
} from "../src/x402/wallet-schemes.ts";

const OWNER_KEY = new SigningKey("0x" + "0".repeat(63) + "1");
const OWNER = computeAddress(OWNER_KEY.publicKey);
const WALLET = "0x9cA70B93CaE5576645F5F069524A9B9c3aef5006";
const CHAIN_ID = 8453;

test("ecdsa-bare signs the raw digest; recovery matches the owner", async () => {
	const scheme = ecdsaBareScheme(OWNER_KEY);
	const digest = "0x" + "ab".repeat(32);
	const sig = await scheme.sign(digest, { wallet: WALLET, chainId: CHAIN_ID });
	// Bare ECDSA: recover over the digest itself.
	const r = sig.slice(0, 66);
	const s = "0x" + sig.slice(66, 130);
	const v = parseInt(sig.slice(130, 132), 16);
	const recovered = SigningKey.recoverPublicKey(digest, { r, s, v, yParity: (v - 27) as 0 | 1 });
	assert.equal(computeAddress(recovered), OWNER);
});

test("safe-message wraps the digest in the SafeMessage EIP-712 hash", async () => {
	const scheme = safeMessageScheme(OWNER_KEY);
	const digest = "0x" + "cd".repeat(32);
	const sig = await scheme.sign(digest, { wallet: WALLET, chainId: CHAIN_ID });
	const wrapped = TypedDataEncoder.hash(
		{ chainId: CHAIN_ID, verifyingContract: WALLET },
		{ SafeMessage: [{ name: "message", type: "bytes" }] },
		{ message: digest },
	);
	const r = sig.slice(0, 66);
	const s = "0x" + sig.slice(66, 130);
	const v = parseInt(sig.slice(130, 132), 16);
	const recovered = SigningKey.recoverPublicKey(wrapped, { r, s, v, yParity: (v - 27) as 0 | 1 });
	assert.equal(computeAddress(recovered), OWNER);
});

test("slhdsa-raw passes the external PQ signature through unchanged", async () => {
	const pqSig = "0x" + "ef".repeat(3928); // ~7,856-byte SLH-DSA sig
	const scheme = slhDsaRawScheme(() => pqSig);
	const sig = await scheme.sign("0x" + "00".repeat(32), { wallet: WALLET, chainId: CHAIN_ID });
	assert.equal(sig, pqSig);
});

test("erc1271Call builds the isValidSignature calldata", () => {
	const call = erc1271Call(WALLET, CANARY_DIGEST, "0x" + "ab".repeat(65));
	assert.equal(call.to, WALLET);
	assert.ok(call.data.startsWith(ERC1271_MAGIC));
});

test("supportsErc1271Call builds the ERC-165 supportsInterface calldata", () => {
	const call = supportsErc1271Call(WALLET);
	assert.ok(call.data.startsWith("0x01ffc9a7"));
});

test("assertSchemeValid accepts when the wallet returns the magic", async () => {
	const scheme = ecdsaBareScheme(OWNER_KEY);
	const ethCall = async () => "0x" + ERC1271_MAGIC.replace(/^0x/, "").padEnd(64, "0");
	const result = await assertSchemeValid({
		wallet: WALLET,
		scheme,
		context: { wallet: WALLET, chainId: CHAIN_ID },
		ethCall,
		signProbe: (digest) => scheme.sign(digest, { wallet: WALLET, chainId: CHAIN_ID }),
	});
	assert.deepEqual(result, { ok: true });
});

test("assertSchemeValid fails closed when the wallet rejects the probe", async () => {
	const scheme = ecdsaBareScheme(OWNER_KEY);
	const ethCall = async () => "0x" + "00".repeat(32);
	const result = await assertSchemeValid({
		wallet: WALLET,
		scheme,
		context: { wallet: WALLET, chainId: CHAIN_ID },
		ethCall,
		signProbe: (digest) => scheme.sign(digest, { wallet: WALLET, chainId: CHAIN_ID }),
	});
	assert.equal(result.ok, false);
});

test("assertSchemeValid fails closed when the probe throws", async () => {
	const scheme = ecdsaBareScheme(OWNER_KEY);
	const ethCall = async () => {
		throw new Error("rpc down");
	};
	const result = await assertSchemeValid({
		wallet: WALLET,
		scheme,
		context: { wallet: WALLET, chainId: CHAIN_ID },
		ethCall,
		signProbe: (digest) => scheme.sign(digest, { wallet: WALLET, chainId: CHAIN_ID }),
	});
	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.reason : "", /probe failed/);
});

test("the registry registers and looks up schemes by id", () => {
	const registry = createSchemeRegistry([ecdsaBareScheme(OWNER_KEY)]);
	assert.ok(registry.byId("ecdsa-bare"));
	assert.equal(registry.byId("nope"), undefined);
	registry.register(safeMessageScheme(OWNER_KEY));
	assert.deepEqual(registry.ids().sort(), ["ecdsa-bare", "safe-message"]);
});
