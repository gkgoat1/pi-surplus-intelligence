import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import { createPayingFetch, X402_FETCH_MARKER, type PayingFetchMarker } from "../src/x402/hook.ts";

const wallet = new Wallet("0x" + "0".repeat(63) + "1");
const CONFIG = { signer: wallet, maxPerRequestUsdc: 0.25 };

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

function markerOf(fn: unknown): PayingFetchMarker | undefined {
	return (fn as Record<symbol, PayingFetchMarker>)[X402_FETCH_MARKER];
}

/** A minimal logging hook, standing in for any third-party wrapper. */
function loggingFetch(base: typeof fetch, log: { status: number }[]): typeof fetch {
	return (async (input, init) => {
		const response = await base(input, init);
		log.push({ status: response.status });
		return response;
	}) as typeof fetch;
}

/** A minimal retry hook: one retry on a thrown network error. */
function retryFetch(base: typeof fetch): typeof fetch {
	return (async (input, init) => {
		try {
			return await base(input, init);
		} catch (error) {
			return base(input, init);
		}
	}) as typeof fetch;
}

function challengeThenOk(counter: { n: number }): typeof fetch {
	return (async () => {
		counter.n += 1;
		return counter.n === 1
			? new Response(JSON.stringify(CHALLENGE), { status: 402, headers: { "content-type": "application/json" } })
			: new Response("{\"answer\":1}", { status: 200 });
	}) as typeof fetch;
}

test("logging outside the payment hook sees only the settled response", async () => {
	const log: { status: number }[] = [];
	const counter = { n: 0 };
	const base = challengeThenOk(counter);
	// Compose: caller -> logging -> paying -> base.
	const composed = loggingFetch(createPayingFetch(base, CONFIG), log);
	const response = await composed("https://surp.ivc.lol/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 200);
	assert.deepEqual(log, [{ status: 200 }], "the 402 is handled inside; outer hooks see the settled response");
	assert.equal(counter.n, 2);
});

test("logging inside the payment hook sees the 402 and the paid retry", async () => {
	const log: { status: number }[] = [];
	const counter = { n: 0 };
	const base = challengeThenOk(counter);
	// Compose: caller -> paying -> logging -> base (payment innermost-visible).
	const composed = createPayingFetch(loggingFetch(base, log), CONFIG);
	const response = await composed("https://surp.ivc.lol/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 200);
	assert.deepEqual(log, [{ status: 402 }, { status: 200 }]);
});

test("an outer retry hook re-invokes the paying fetch without extra signatures on success", async () => {
	let signCount = 0;
	const baseSigner = new Wallet(CONFIG.signer.privateKey);
	const countingSigner = {
		getAddress: () => baseSigner.getAddress(),
		signTypedData: (...args: Parameters<Wallet["signTypedData"]>) => {
			signCount += 1;
			return baseSigner.signTypedData(...args);
		},
	} as unknown as Wallet;
	const counter = { n: 0 };
	const base: typeof fetch = async () => {
		counter.n += 1;
		if (counter.n === 1) throw new TypeError("fetch failed"); // network-level failure
		if (counter.n === 2) {
			return new Response(JSON.stringify(CHALLENGE), { status: 402, headers: { "content-type": "application/json" } });
		}
		return new Response("{\"ok\":true}", { status: 200 });
	};
	const composed = retryFetch(createPayingFetch(base, { ...CONFIG, signer: countingSigner }));
	const response = await composed("https://surp.ivc.lol/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 200);
	assert.equal(signCount, 1, "one settled request, one signature");
});

test("the settled response body is readable through the Proxy", async () => {
	const counter = { n: 0 };
	const composed = createPayingFetch(challengeThenOk(counter), CONFIG);
	const response = await composed("https://surp.ivc.lol/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(await response.text(), "{\"answer\":1}");
});

test("a hook that spreads the fetch function does not capture the marker", () => {
	const composed = createPayingFetch((async () => new Response()) as typeof fetch, CONFIG);
	const spread = { ...composed };
	assert.equal(Object.keys(spread).length, 0);
	assert.equal((spread as Record<symbol, unknown>)[X402_FETCH_MARKER], undefined);
	assert.ok(markerOf(composed), "the marker itself still reads through the Proxy");
});
