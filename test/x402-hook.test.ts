import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import { createPayingFetch, X402_FETCH_MARKER, type PayingFetchMarker } from "../src/x402/hook.ts";
import type { PayingFetchConfig } from "../src/x402/pay.ts";

const wallet = new Wallet("0x" + "0".repeat(63) + "1");
const CONFIG: PayingFetchConfig = { signer: wallet, maxPerRequestUsdc: 0.25 };

const CHALLENGE = {
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

function challengeThenOk(counter?: { n: number }): typeof fetch {
	return (async () => {
		if (counter) counter.n += 1;
		const call = counter?.n ?? 0;
		if (call === 1 || !counter) {
			return new Response(JSON.stringify(CHALLENGE), {
				status: 402,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("{\"ok\":true}", { status: 200 });
	}) as typeof fetch;
}

function markerOf(fn: unknown): PayingFetchMarker | undefined {
	return (fn as Record<symbol, PayingFetchMarker>)[X402_FETCH_MARKER];
}

test("the marker is readable via the symbol and invisible to enumeration", () => {
	const wrapped = createPayingFetch((async () => new Response()) as typeof fetch, CONFIG);
	assert.ok(markerOf(wrapped));
	assert.equal(Object.keys(wrapped).length, 0);
	assert.equal(JSON.stringify({ ...wrapped }), "{}");
	assert.equal(X402_FETCH_MARKER in wrapped, true);
	const descriptor = Object.getOwnPropertyDescriptor(wrapped, X402_FETCH_MARKER);
	assert.equal(descriptor?.enumerable, false);
});

test("the marker descriptor carries version 1 and the inner base fetch", () => {
	const base = (async () => new Response()) as typeof fetch;
	const wrapped = createPayingFetch(base, CONFIG);
	const marker = markerOf(wrapped);
	assert.equal(marker?.version, 1);
	assert.equal(marker?.inner, base);
});

test("re-wrapping an already-marked fetch reconfigures in place instead of stacking", () => {
	const counter = { n: 0 };
	const base = challengeThenOk(counter);
	const first = createPayingFetch(base, CONFIG);
	// Re-wrap with a tighter ceiling. If this stacked, the inner loop would
	// pay first and the outer would pay again or double-sign.
	const second = createPayingFetch(first, { ...CONFIG, maxPerRequestUsdc: 0.5 });
	assert.equal(markerOf(second)?.inner, base, "inner stays the original base fetch");
});

test("the wrapped fetch pays a 402 challenge exactly like payingFetch", async () => {
	let paymentHeaders: (string | null)[] = [];
	let n = 0;
	const base: typeof fetch = async (input, init) => {
		n += 1;
		paymentHeaders.push(new Request(input, init).headers.get("x-payment"));
		return n === 1
			? new Response(JSON.stringify(CHALLENGE), { status: 402, headers: { "content-type": "application/json" } })
			: new Response("{\"ok\":true}", { status: 200 });
	};
	const wrapped = createPayingFetch(base, CONFIG);
	const response = await wrapped("https://surp.ivc.lol/v1/chat/completions", {
		method: "POST",
		body: "{}",
	});
	assert.equal(response.status, 200);
	assert.equal(paymentHeaders.length, 2);
	assert.equal(paymentHeaders[0], null);
	assert.ok(paymentHeaders[1], "the retry carries the payment header");
});

test("a non-paying caller sees an ordinary fetch-shaped function", async () => {
	const base = (async () => new Response("plain", { status: 200 })) as typeof fetch;
	const wrapped = createPayingFetch(base, CONFIG);
	assert.equal(typeof wrapped, "function");
	const response = await wrapped("https://example.com");
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "plain");
});
