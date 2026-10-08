import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import { payingFetch, type PayingFetchConfig } from "../src/x402/pay.ts";

/**
 * R-3 pass-through proofs: a 402 that is not a valid, payable x402 challenge
 * must reach the caller untouched, and the signer must never be invoked.
 * Bu0y's balance signal is the canonical case: its 402 means "fund the
 * account", not "pay this challenge".
 */
const TEST_KEY = "0x" + "0".repeat(63) + "1";

function makeCountingSigner(): { signer: Wallet; signCount: () => number } {
	let count = 0;
	const wallet = new Wallet(TEST_KEY);
	const proxy = new Proxy(wallet, {
		get(target, prop, receiver) {
			if (prop === "signTypedData") count += 1;
			return Reflect.get(target, prop, receiver);
		},
	});
	return { signer: proxy, signCount: () => count };
}

const baseConfig = (): Omit<PayingFetchConfig, "signer"> => ({ maxPerRequestUsdc: 0.25 });

test("a Bu0y-shaped bare 402 passes through with body intact", async () => {
	const { signer, signCount } = makeCountingSigner();
	const stub: typeof fetch = async () =>
		new Response(JSON.stringify({ error: "insufficient balance", reserveMicros: 32 }), {
			status: 402,
			headers: { "content-type": "application/json" },
		});
	const pay = payingFetch(stub, { ...baseConfig(), signer });
	const response = await pay("https://api.bu0y.com/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 402);
	const body = (await response.json()) as { error: string; reserveMicros: number };
	assert.equal(body.error, "insufficient balance");
	assert.equal(body.reserveMicros, 32);
	assert.equal(signCount(), 0);
});

test("a 402 with invalid base64 in the requirements header passes through", async () => {
	const { signer, signCount } = makeCountingSigner();
	const stub: typeof fetch = async () =>
		new Response("", { status: 402, headers: { "payment-required": "%%%invalid-base64%%%" } });
	const pay = payingFetch(stub, { ...baseConfig(), signer });
	const response = await pay("https://surp.ivc.lol/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 402);
	assert.equal(signCount(), 0);
});

test("a 402 with a malformed accepts value passes through", async () => {
	const { signer, signCount } = makeCountingSigner();
	const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: "not-an-array" })).toString("base64");
	const stub: typeof fetch = async () =>
		new Response("", { status: 402, headers: { "payment-required": header } });
	const pay = payingFetch(stub, { ...baseConfig(), signer });
	const response = await pay("https://surp.ivc.lol/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 402);
	assert.equal(signCount(), 0);
});

test("the loop guard: even endless 402s produce exactly one retry", async () => {
	const challenge = {
		x402Version: 2,
		accepts: [
			{
				scheme: "exact",
				network: "eip155:8453",
				asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
				amount: "10000",
				payTo: "0x2f9518019575e048320c1e7da4dc4d6d8384c2c8",
				maxTimeoutSeconds: 600,
			},
		],
	};
	let callCount = 0;
	const stub: typeof fetch = async () => {
		callCount += 1;
		return new Response(JSON.stringify(challenge), { status: 402, headers: { "content-type": "application/json" } });
	};
	const pay = payingFetch(stub, { ...baseConfig(), signer: new Wallet(TEST_KEY) });
	const response = await pay("https://surp.ivc.lol/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 402);
	assert.equal(callCount, 2);
});
