/**
 * x402 payment-requirements parsing and EIP-3009 signing.
 *
 * The parser accepts the shapes seen in the wild (docs/probe-results.md):
 * v1 challenges use `maxAmountRequired` and the `X-Payment-Requirements`
 * header; v2 challenges (Surp, Surplus Intelligence) use `amount`, network
 * `eip155:8453`, and the `payment-required` header or a JSON body. Parsing
 * fails closed: anything not recognised yields no requirements, and a 402
 * without requirements is never paid (plan R-3).
 *
 * Signing uses ethers v6 `signTypedData` against the USDC EIP-3009 domain.
 * The client only signs; the facilitator submits the on-chain transfer, so
 * the wallet needs USDC but no ETH.
 */
import { randomBytes, hexlify, type Signer, type TypedDataField } from "ethers";

/** USDC on Base mainnet. */
export const USDC_BASE_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_CHAIN_ID = 8453;
export const BASE_NETWORK = "eip155:8453";
export const SUPPORTED_SCHEME = "exact";
/** Token names per network, for the EIP-712 domain. */
const TOKEN_DOMAIN_NAMES: Record<string, { name: string; version: string }> = {
	[BASE_NETWORK]: { name: "USD Coin", version: "2" },
};

export const EIP3009_TYPES: Record<string, TypedDataField[]> = {
	TransferWithAuthorization: [
		{ name: "from", type: "address" },
		{ name: "to", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "validAfter", type: "uint256" },
		{ name: "validBefore", type: "uint256" },
		{ name: "nonce", type: "bytes32" },
	],
};

export type PaymentRequirement = {
	scheme: string;
	network: string;
	asset: string;
	/** Atomic token units as a decimal string (v1 `maxAmountRequired` / v2 `amount`). */
	amount: string;
	payTo: string;
	maxTimeoutSeconds: number;
};

export type ParsedRequirements =
	| { ok: true; requirements: PaymentRequirement[] }
	| { ok: false };

const REQUIREMENTS_HEADERS = ["x-payment-requirements", "payment-required"];

function parseRequirementEntry(entry: unknown): PaymentRequirement | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const record = entry as Record<string, unknown>;
	const amount = record.maxAmountRequired ?? record.amount;
	const timeout = record.maxTimeoutSeconds;
	if (
		record.scheme !== SUPPORTED_SCHEME ||
		typeof record.network !== "string" ||
		typeof record.asset !== "string" ||
		typeof amount !== "string" ||
		!/^[0-9]+$/.test(amount) ||
		typeof record.payTo !== "string" ||
		typeof timeout !== "number"
	) {
		return undefined;
	}
	return {
		scheme: record.scheme,
		network: record.network,
		asset: record.asset,
		amount,
		payTo: record.payTo,
		maxTimeoutSeconds: timeout,
	};
}

function parseRequirementsPayload(payload: unknown): PaymentRequirement[] {
	if (typeof payload !== "object" || payload === null) return [];
	const accepts = (payload as Record<string, unknown>).accepts;
	if (!Array.isArray(accepts)) return [];
	return accepts.flatMap((entry) => {
		const parsed = parseRequirementEntry(entry);
		return parsed ? [parsed] : [];
	});
}

function parseJsonObjectMaybe(text: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * Extract payment requirements from a 402 response. Header first (both known
 * header names), then the JSON body. Returns `{ ok: false }` when nothing
 * usable is present — the caller must then leave the response untouched.
 */
export async function parsePaymentRequirements(response: Response): Promise<ParsedRequirements> {
	if (response.status !== 402) return { ok: false };

	for (const headerName of REQUIREMENTS_HEADERS) {
		const headerValue = response.headers.get(headerName);
		if (!headerValue) continue;
		try {
			const decoded = Buffer.from(headerValue, "base64").toString("utf8");
			const requirements = parseRequirementsPayload(parseJsonObjectMaybe(decoded));
			if (requirements.length > 0) return { ok: true, requirements };
		} catch {
			// Undecodable header: fall through to the body.
		}
	}

	const bodyText = await response.text().catch(() => "");
	const requirements = parseRequirementsPayload(parseJsonObjectMaybe(bodyText));
	if (requirements.length > 0) return { ok: true, requirements };
	return { ok: false };
}

/** Networks and assets this client can pay on. Fail closed for anything else. */
export function isSupportedRequirement(requirement: PaymentRequirement): boolean {
	return (
		requirement.scheme === SUPPORTED_SCHEME &&
		requirement.network === BASE_NETWORK &&
		requirement.asset.toLowerCase() === USDC_BASE_CONTRACT.toLowerCase()
	);
}

/** Pick the first requirement this client can actually pay, if any. */
export function pickRequirement(requirements: PaymentRequirement[]): PaymentRequirement | undefined {
	return requirements.find(isSupportedRequirement);
}

export type SignedAuthorization = {
	/** The EIP-3009 message fields, decimal strings for uint256 values. */
	authorization: {
		from: string;
		to: string;
		value: string;
		validAfter: string;
		validBefore: string;
		nonce: string;
	};
	signature: string;
};

export type SignOptions = {
	/** Clock override for tests; seconds since the epoch. */
	nowSeconds?: number;
};

/**
 * Sign a `TransferWithAuthorization` for one requirement. `validAfter` is 0,
 * `validBefore` is now plus the offered timeout, and the nonce is 32 random
 * bytes, per the x402 exact scheme.
 */
export async function signTransferAuthorization(
	signer: Signer,
	requirement: PaymentRequirement,
	options: SignOptions = {},
): Promise<SignedAuthorization> {
	const tokenDomain = TOKEN_DOMAIN_NAMES[requirement.network];
	if (!tokenDomain) {
		throw new Error(`x402: no token domain known for network ${requirement.network}`);
	}
	const from = await signer.getAddress();
	const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
	const authorization = {
		from,
		to: requirement.payTo,
		value: requirement.amount,
		validAfter: "0",
		validBefore: String(nowSeconds + requirement.maxTimeoutSeconds),
		nonce: hexlify(randomBytes(32)),
	};
	const signature = await signer.signTypedData(
		{
			name: tokenDomain.name,
			version: tokenDomain.version,
			chainId: BASE_CHAIN_ID,
			verifyingContract: requirement.asset,
		},
		EIP3009_TYPES,
		{
			from: authorization.from,
			to: authorization.to,
			value: BigInt(authorization.value),
			validAfter: 0n,
			validBefore: BigInt(authorization.validBefore),
			nonce: authorization.nonce,
		},
	);
	return { authorization, signature };
}
