import assert from "node:assert/strict";
import { test } from "node:test";
import {
	configurePayments,
	hostAllowed,
	paymentState,
	releasePayments,
	DEFAULT_ALLOWED_HOSTS,
} from "../src/x402/payments.ts";
import { X402_FETCH_MARKER } from "../src/x402/hook.ts";

const TEST_KEY = "0x" + "0".repeat(63) + "1";
const TEST_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

test("no wallet configured leaves payments off and stays silent", () => {
	const diagnostic = configurePayments("s1", {}, { env: {} });
	assert.equal(diagnostic, undefined);
	assert.equal(paymentState("s1"), undefined);
	releasePayments("s1");
});

test("a wallet from the environment enables payments with a marked fetch", () => {
	const diagnostic = configurePayments("s2", {}, { env: { X402_WALLET_KEY: TEST_KEY } });
	assert.equal(diagnostic, undefined);
	const state = paymentState("s2");
	assert.ok(state);
	assert.equal(state.address, TEST_ADDRESS);
	assert.equal(typeof state.fetch, "function");
	assert.ok((state.fetch as any)[X402_FETCH_MARKER], "the session fetch carries the marker");
	releasePayments("s2");
	assert.equal(paymentState("s2"), undefined);
});

test("a broken wallet config surfaces a diagnostic and disables payments", () => {
	const diagnostic = configurePayments("s3", { walletPrivateKey: "$UNSET_WALLET_VAR" }, { env: {} });
	assert.match(diagnostic ?? "", /x402 payments disabled/);
	assert.equal(paymentState("s3"), undefined);
	releasePayments("s3");
});

test("the default allowlist holds exactly the probed x402 hosts", () => {
	assert.deepEqual([...DEFAULT_ALLOWED_HOSTS].sort(), ["api.surplusintelligence.ai", "surp.ivc.lol"]);
});

test("hostAllowed matches exactly, case-insensitively, no subdomains", () => {
	assert.equal(hostAllowed("surp.ivc.lol", DEFAULT_ALLOWED_HOSTS), true);
	assert.equal(hostAllowed("SURP.IVC.LOL", DEFAULT_ALLOWED_HOSTS), true);
	assert.equal(hostAllowed("evil-surp.ivc.lol", DEFAULT_ALLOWED_HOSTS), false);
	assert.equal(hostAllowed("surp.ivc.lol.evil.com", DEFAULT_ALLOWED_HOSTS), false);
	assert.equal(hostAllowed("api.openrouter.ai", DEFAULT_ALLOWED_HOSTS), false);
	assert.equal(hostAllowed("surp.ivc.lol", []), false);
});

test("a wallet signer pays a live-shaped 402 through the session fetch", async () => {
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
	const originalFetch = globalThis.fetch;
	let n = 0;
	globalThis.fetch = (async () => {
		n += 1;
		return n === 1
			? new Response(JSON.stringify(challenge), { status: 402, headers: { "content-type": "application/json" } })
			: new Response("{\"ok\":true}", { status: 200 });
	}) as typeof fetch;
	try {
		configurePayments("s4", {}, { env: { X402_WALLET_KEY: TEST_KEY } });
		const state = paymentState("s4");
		assert.ok(state);
		const response = await state.fetch("https://surp.ivc.lol/v1/chat/completions", {
			method: "POST",
			body: "{}",
		});
		assert.equal(response.status, 200);
		assert.equal(n, 2, "one challenge, one paid retry");
	} finally {
		globalThis.fetch = originalFetch;
		releasePayments("s4");
	}
});
