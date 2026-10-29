/**
 * Pluggable smart-wallet signature schemes for x402 (the `eth` agent's
 * inventory: wallitify bare-digest ERC-1271, Safe SafeMessage-wrapped
 * ERC-1271, Cell/sphinc SLH-DSA raw ERC-1271, and ERC-4337 validateUserOp).
 *
 * A scheme knows how to (a) produce the signature bytes the wallet accepts
 * for a 32-byte payment digest, and (b) build the on-chain `isValidSignature`
 * verification call. Schemes are arbitrary, so before a wallet+scheme pair is
 * trusted, `assertSchemeValid` runs an on-chain canary: sign a fixed probe
 * digest and require the wallet to return the ERC-1271 magic.
 *
 * Scheme semantics (from the eth inventory):
 * - ecdsa-bare: owner ECDSA over the raw digest, no wrap (wallitify).
 * - safe-message: owner ECDSA over the SafeMessage EIP-712 hash (Safe).
 * - slhdsa-raw: an externally-produced SLH-DSA-SHA2-128s signature over the
 *   raw digest, passed through unchanged (Cell/sphinc-wallet; ~7,856-byte
 *   sigs, ~2M gas verify floor, no wrap). Signing is delegated to a caller
 *   plug-in because SLH-DSA needs the wallet owner's PQ key.
 */
import { SigningKey, TypedDataEncoder } from "ethers";

/** ERC-1271 magic value for a valid signature. */
export const ERC1271_MAGIC = "0x1626ba7e";
/** ERC-165 interface id for IERC1271 (isValidSignature(bytes32,bytes)). */
export const ERC1271_INTERFACE_ID = "0x1626ba7e";

/** The 32-byte payment digest (0x-prefixed hex) to sign. */
export type PaymentDigest = string;

/** Context for signing: the wallet contract and chain. */
export type SignContext = {
	wallet: string;
	chainId: number;
};

/**
 * A pluggable signer: given the 32-byte digest, produce the signature bytes
 * the wallet accepts. ECDSA schemes use an owner SigningKey; SLH-DSA schemes
 * take an external PQ signer function.
 */
export type SchemeSignFn = (digest: PaymentDigest, context: SignContext) => Promise<string> | string;

export type WalletScheme = {
	readonly id: string;
	/** Sign the payment digest per the wallet's acceptance rule. */
	readonly sign: SchemeSignFn;
};

/** Build the ERC-1271 isValidSignature(bytes32,bytes) eth_call. */
export function erc1271Call(wallet: string, digest: string, signature: string): { to: string; data: string } {
	const sigBytes = signature.replace(/^0x/, "");
	const offset = (64).toString(16).padStart(64, "0");
	const length = (sigBytes.length / 2).toString(16).padStart(64, "0");
	const padded = sigBytes.padEnd(Math.ceil(sigBytes.length / 64) * 64, "0");
	return { to: wallet, data: `${ERC1271_MAGIC}${digest.replace(/^0x/, "")}${offset}${length}${padded}` };
}

/** The ERC-165 supportsInterface call for IERC1271. */
export function supportsErc1271Call(wallet: string): { to: string; data: string } {
	// supportsInterface(bytes4) selector 0x01ffc9a7.
	return { to: wallet, data: `0x01ffc9a7${ERC1271_INTERFACE_ID.replace(/^0x/, "").padStart(64, "0")}` };
}

/** A fixed probe digest for the validity canary (deterministic, never paid). */
export const CANARY_DIGEST = "0x" + "00".repeat(31) + "01";

/**
 * On-chain validity pre-check for a wallet+scheme pair. Schemes are
 * arbitrary, so before trusting one we require the wallet to (a) be a
 * contract, (b) support ERC-1271, and (c) accept a scheme signature over the
 * probe digest. `ethCall` returns 0x-prefixed return data; `signProbe` signs
 * the canary with the real owner/PQ signer.
 */
export async function assertSchemeValid(options: {
	wallet: string;
	scheme: WalletScheme;
	context: SignContext;
	ethCall: (to: string, data: string) => Promise<string>;
	/** Sign the canary digest with the real signer (owner key or PQ plug-in). */
	signProbe: (digest: PaymentDigest) => Promise<string> | string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
	const { wallet, context, ethCall, signProbe } = options;
	// (a) contract code present — checked by the caller via getCode; here we
	// rely on the ethCalls failing closed for EOAs.
	try {
		const support = await ethCall(wallet, supportsErc1271Call(wallet).data);
		if (!support.toLowerCase().startsWith("0x" + "0".repeat(63) + "1")) {
			// supportsInterface may be absent; fall through to the canary.
		}
	} catch {
		// supportsInterface unsupported: continue to the canary.
	}
	try {
		const signature = await signProbe(CANARY_DIGEST);
		const call = erc1271Call(wallet, CANARY_DIGEST, signature);
		const result = await ethCall(call.to, call.data);
		if (result.slice(0, 10).toLowerCase() !== ERC1271_MAGIC) {
			return { ok: false, reason: "wallet rejected the scheme's probe signature" };
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `probe failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

// ── Built-in schemes ────────────────────────────────────────────────────────

function ecdsaJoined(key: SigningKey, digest: string): string {
	const sig = key.sign(digest);
	return `0x${sig.r.slice(2)}${sig.s.slice(2)}${sig.yParity === 0 ? "1b" : "1c"}`;
}

/** wallitify-style: the owner signs the raw digest; the wallet ecrecovers. */
export function ecdsaBareScheme(ownerKey: SigningKey): WalletScheme {
	return {
		id: "ecdsa-bare",
		sign: (digest) => ecdsaJoined(ownerKey, digest),
	};
}

/** Safe-style: the owner signs the SafeMessage EIP-712 wrap of the digest. */
export function safeMessageScheme(ownerKey: SigningKey): WalletScheme {
	return {
		id: "safe-message",
		sign: (digest, context) =>
			ecdsaJoined(
				ownerKey,
				TypedDataEncoder.hash(
					{ chainId: context.chainId, verifyingContract: context.wallet },
					{ SafeMessage: [{ name: "message", type: "bytes" }] },
					{ message: digest },
				),
			),
	};
}

/**
 * Cell/sphinc-style: the signature is an externally-produced SLH-DSA
 * signature over the raw digest, passed through unchanged. `pqSigner` is the
 * wallet owner's PQ signing plug-in (SLH-DSA needs the owner's key).
 */
export function slhDsaRawScheme(pqSigner: (digest: PaymentDigest) => Promise<string> | string): WalletScheme {
	return {
		id: "slhdsa-raw",
		sign: (digest) => pqSigner(digest),
	};
}

/** Registry lookup by id, with the signer supplied per scheme kind. */
export type SchemeRegistry = {
	byId(id: string): WalletScheme | undefined;
	register(scheme: WalletScheme): void;
	ids(): string[];
};

export function createSchemeRegistry(builtins: WalletScheme[] = []): SchemeRegistry {
	const schemes = new Map<string, WalletScheme>();
	for (const scheme of builtins) schemes.set(scheme.id, scheme);
	return {
		byId: (id) => schemes.get(id),
		register: (scheme) => void schemes.set(scheme.id, scheme),
		ids: () => [...schemes.keys()],
	};
}
