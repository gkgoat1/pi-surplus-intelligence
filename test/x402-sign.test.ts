import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyTypedData, Wallet } from "ethers";
import {
	EIP3009_TYPES,
	parsePaymentRequirements,
	pickRequirement,
	signTransferAuthorization,
} from "../src/x402/sign.ts";

/** The 402 Surp returned to the live probe on 2026-10-08 (docs/probe-results.md). */
const SURP_CHALLENGE_BODY = JSON.stringify({
	x402Version: 2,
	error: "payment-required",
	resource: "POST /v1/chat/completions",
	accepts: [
		{
			scheme: "exact",
			network: "eip155:8453",
			asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			amount: "10000",
			payTo: "0x2f9518019575e048320c1e7da4dc4d6d8384c2c8",
			maxTimeoutSeconds: 600,
			extra: { description: "surp.ivc.lol: value -> glm-5.3-flash" },
		},
	],
});

function fixture(options: { status: number; headers?: Record<string, string>; body?: string }): Response {
	return {
		status: options.status,
		headers: new Headers(options.headers ?? {}),
		text: async () => options.body ?? "",
	} as unknown as Response;
}

test("parses the recorded Surp v2 challenge from the body", async () => {
	const parsed = await parsePaymentRequirements(fixture({ status: 402, body: SURP_CHALLENGE_BODY }));
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.requirements.length, 1);
	const req = parsed.requirements[0];
	assert.equal(req.scheme, "exact");
	assert.equal(req.network, "eip155:8453");
	assert.equal(req.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
	assert.equal(req.amount, "10000");
	assert.equal(req.payTo, "0x2f9518019575e048320c1e7da4dc4d6d8384c2c8");
	assert.equal(req.maxTimeoutSeconds, 600);
});

test("parses a challenge from the base64 payment-required header", async () => {
	const header = Buffer.from(SURP_CHALLENGE_BODY).toString("base64");
	const parsed = await parsePaymentRequirements(
		fixture({ status: 402, headers: { "payment-required": header } }),
	);
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.requirements.length, 1);
});

test("a malformed requirements header yields no requirements", async () => {
	const parsed = await parsePaymentRequirements(
		fixture({ status: 402, headers: { "payment-required": "!!!not-base64!!!" } }),
	);
	assert.equal(parsed.ok, false);
});

test("requirements with only unsupported networks are not usable", async () => {
	const body = JSON.stringify({
		x402Version: 2,
		accepts: [
			{
				scheme: "exact",
				network: "solana:mainnet",
				asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
				amount: "10000",
				payTo: "some-solana-address",
				maxTimeoutSeconds: 60,
			},
		],
	});
	const parsed = await parsePaymentRequirements(fixture({ status: 402, body }));
	// Structurally valid but on a network we cannot pay: parsing succeeds,
	// yet there is nothing usable.
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(pickRequirement(parsed.requirements), undefined);
});

test("pickRequirement chooses the Base-USDC exact entry", async () => {
	const body = JSON.stringify({
		x402Version: 2,
		accepts: [
			{
				scheme: "exact",
				network: "solana:mainnet",
				asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
				amount: "10000",
				payTo: "some-solana-address",
				maxTimeoutSeconds: 60,
			},
			{
				scheme: "exact",
				network: "eip155:8453",
				asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
				amount: "10000",
				payTo: "0x2f9518019575e048320c1e7da4dc4d6d8384c2c8",
				maxTimeoutSeconds: 600,
			},
		],
	});
	const parsed = await parsePaymentRequirements(fixture({ status: 402, body }));
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(pickRequirement(parsed.requirements)?.network, "eip155:8453");
});

const TEST_KEY = "0x" + "0".repeat(63) + "1";
const TEST_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

const REQUIREMENT = {
	scheme: "exact",
	network: "eip155:8453",
	asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
	amount: "10000",
	payTo: "0x2f9518019575e048320c1e7da4dc4d6d8384c2c8",
	maxTimeoutSeconds: 600,
};

test("signs an authorization that recovers to the test wallet", async () => {
	const wallet = new Wallet(TEST_KEY);
	const signed = await signTransferAuthorization(wallet, REQUIREMENT, { nowSeconds: 1_700_000_000 });
	assert.equal(signed.authorization.from, TEST_ADDRESS);
	assert.equal(signed.authorization.to, REQUIREMENT.payTo);
	assert.equal(signed.authorization.value, "10000");
	assert.equal(signed.authorization.validAfter, "0");
	assert.equal(signed.authorization.validBefore, String(1_700_000_000 + 600));
	assert.match(signed.authorization.nonce, /^0x[0-9a-f]{64}$/);
	const domain = {
		name: "USD Coin",
		version: "2",
		chainId: 8453,
		verifyingContract: REQUIREMENT.asset,
	};
	const recovered = verifyTypedData(
		domain,
		EIP3009_TYPES,
		{
			from: signed.authorization.from,
			to: signed.authorization.to,
			value: BigInt(signed.authorization.value),
			validAfter: BigInt(signed.authorization.validAfter),
			validBefore: BigInt(signed.authorization.validBefore),
			nonce: signed.authorization.nonce,
		},
		signed.signature,
	);
	assert.equal(recovered, TEST_ADDRESS);
});

test("validBefore is now plus the offered timeout, exactly", async () => {
	const wallet = new Wallet(TEST_KEY);
	const signed = await signTransferAuthorization(
		wallet,
		{ ...REQUIREMENT, maxTimeoutSeconds: 30 },
		{ nowSeconds: 1_800_000_000 },
	);
	assert.equal(signed.authorization.validBefore, String(1_800_000_030));
});
