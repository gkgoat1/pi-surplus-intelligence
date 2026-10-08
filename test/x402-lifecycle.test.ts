import assert from "node:assert/strict";
import { test } from "node:test";
import { configurePayments, releasePayments, paymentState } from "../src/x402/payments.ts";
import { X402_FETCH_MARKER, type PayingFetchMarker } from "../src/x402/hook.ts";

const TEST_KEY = `0x${"0".repeat(63)}1`;

function markerOf(fn: unknown): PayingFetchMarker | undefined {
	return (fn as Record<symbol, PayingFetchMarker>)[X402_FETCH_MARKER];
}

test("three sequential sessions keep one marker and restore the original fetch", () => {
	const original = globalThis.fetch;
	try {
		for (const sessionId of ["seq-1", "seq-2", "seq-3"]) {
			configurePayments(sessionId, {}, { env: { X402_WALLET_KEY: TEST_KEY } });
			assert.ok(markerOf(globalThis.fetch), `${sessionId}: global fetch carries the marker`);
			releasePayments(sessionId);
		}
		assert.equal(globalThis.fetch, original, "the original fetch is restored after the last release");
	} finally {
		globalThis.fetch = original;
	}
});

test("overlapping sessions share one hook; the last release restores", () => {
	const original = globalThis.fetch;
	try {
		configurePayments("a", {}, { env: { X402_WALLET_KEY: TEST_KEY } });
		const installedAfterA = globalThis.fetch;
		configurePayments("b", {}, { env: { X402_WALLET_KEY: TEST_KEY } });
		assert.equal(globalThis.fetch, installedAfterA, "session B reconfigures in place, no second wrap");

		releasePayments("a");
		assert.equal(globalThis.fetch, installedAfterA, "the hook stays installed while B is active");
		assert.equal(paymentState("b")?.address, paymentState("b")?.address);

		releasePayments("b");
		assert.equal(globalThis.fetch, original, "restored once B releases");
	} finally {
		globalThis.fetch = original;
	}
});

test("a 402 paid during overlapping sessions signs exactly once", async () => {
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
	const original = globalThis.fetch;
	let n = 0;
	globalThis.fetch = (async () => {
		n += 1;
		return n === 1
			? new Response(JSON.stringify(challenge), { status: 402, headers: { "content-type": "application/json" } })
			: new Response("{\"ok\":true}", { status: 200 });
	}) as typeof fetch;
	try {
		configurePayments("x", {}, { env: { X402_WALLET_KEY: TEST_KEY } });
		configurePayments("y", {}, { env: { X402_WALLET_KEY: TEST_KEY } });
		const response = await globalThis.fetch("https://surp.ivc.lol/v1/chat/completions", {
			method: "POST",
			body: "{}",
		});
		assert.equal(response.status, 200);
		assert.equal(n, 2, "one challenge, one paid retry through the shared hook");
		releasePayments("x");
		releasePayments("y");
	} finally {
		globalThis.fetch = original;
	}
});
