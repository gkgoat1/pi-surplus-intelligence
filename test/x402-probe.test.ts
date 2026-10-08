import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProbeResponse } from "../scripts/probe-x402.ts";

/**
 * Fixture responses model a minimal `fetch` Response surface: the classifier
 * only reads `status`, header lookups, and a JSON/text body.
 */
function fixture(options: {
	status: number;
	headers?: Record<string, string>;
	body?: string;
}): Response {
	const headers = new Headers(options.headers ?? {});
	return {
		status: options.status,
		headers,
		text: async () => options.body ?? "",
	} as unknown as Response;
}

const VALID_ACCEPTS = {
	x402Version: 1,
	accepts: [
		{
			scheme: "exact",
			network: "base",
			maxAmountRequired: "500",
			asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			payTo: "0x1234567890abcdef1234567890abcdef12345678",
		},
	],
};

test("401 with no body classifies as key-required", async () => {
	const result = await classifyProbeResponse(fixture({ status: 401 }));
	assert.equal(result.classification, "401 key-required");
});

test("402 with a base64 X-Payment-Requirements header classifies as x402", async () => {
	const header = Buffer.from(JSON.stringify(VALID_ACCEPTS)).toString("base64");
	const result = await classifyProbeResponse(
		fixture({ status: 402, headers: { "x-payment-requirements": header } }),
	);
	assert.equal(result.classification, "402 x402");
});

test("402 with a valid accepts array in the JSON body classifies as x402", async () => {
	const result = await classifyProbeResponse(
		fixture({ status: 402, body: JSON.stringify(VALID_ACCEPTS) }),
	);
	assert.equal(result.classification, "402 x402");
});

test("402 with no payment data anywhere classifies as bare", async () => {
	const result = await classifyProbeResponse(
		fixture({ status: 402, body: JSON.stringify({ error: "insufficient balance" }) }),
	);
	assert.equal(result.classification, "402 bare");
});

test("402 with an undecodable requirements header classifies as bare", async () => {
	const result = await classifyProbeResponse(
		fixture({ status: 402, headers: { "x-payment-requirements": "!!!not-base64-json!!!" } }),
	);
	assert.equal(result.classification, "402 bare");
});

test("200 classifies as other", async () => {
	const result = await classifyProbeResponse(
		fixture({ status: 200, body: JSON.stringify({ choices: [] }) }),
	);
	assert.equal(result.classification, "other");
});

test("an accepts entry missing required fields is not x402", async () => {
	const broken = { x402Version: 1, accepts: [{ scheme: "exact" }] };
	const header = Buffer.from(JSON.stringify(broken)).toString("base64");
	const result = await classifyProbeResponse(
		fixture({ status: 402, headers: { "x-payment-requirements": header } }),
	);
	assert.equal(result.classification, "402 bare");
});
