import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import { payingFetch, type PayingFetchConfig } from "../src/x402/pay.ts";

const TEST_KEY = "0x" + "0".repeat(63) + "1";
const wallet = new Wallet(TEST_KEY);

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

function challengeResponse(): Response {
	return new Response(JSON.stringify(CHALLENGE), {
		status: 402,
		headers: { "content-type": "application/json" },
	});
}

function okResponse(body = "{\"ok\":true}"): Response {
	return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

const CONFIG: PayingFetchConfig = { signer: wallet, maxPerRequestUsdc: 0.25 };

test("happy path: 402 with a challenge is signed and retried once", async () => {
	const calls: { url: string; paymentHeader: string | null }[] = [];
	const stub: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		calls.push({ url: request.url, paymentHeader: request.headers.get("x-payment") });
		return calls.length === 1 ? challengeResponse() : okResponse();
	};
	const pay = payingFetch(stub, CONFIG);
	const response = await pay("https://surp.ivc.lol/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify({ model: "surp/value" }),
	});
	assert.equal(response.status, 200);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].paymentHeader, null);
	const paymentHeader = calls[1].paymentHeader;
	assert.ok(paymentHeader, "retry must carry an X-Payment header");
	const payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
	assert.equal(payload.x402Version, 2);
	assert.equal(payload.payload.authorization.value, "10000");
	assert.equal(payload.payload.authorization.to, CHALLENGE.accepts[0].payTo);
});

test("a bare 402 passes through untouched and the signer is never invoked", async () => {
	let signCount = 0;
	const countingSigner = new Proxy(wallet, {
		get(target, prop, receiver) {
			if (prop === "signTypedData") signCount += 1;
			return Reflect.get(target, prop, receiver);
		},
	});
	const stub: typeof fetch = async () =>
		new Response(JSON.stringify({ error: "insufficient balance", reserveMicros: 32 }), { status: 402 });
	const pay = payingFetch(stub, { ...CONFIG, signer: countingSigner });
	const response = await pay("https://api.bu0y.com/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 402);
	const body = (await response.json()) as { error: string };
	assert.equal(body.error, "insufficient balance");
	assert.equal(signCount, 0);
});

test("a challenge above the per-request ceiling passes through unsigned", async () => {
	const expensive = {
		...CHALLENGE,
		accepts: [{ ...CHALLENGE.accepts[0], amount: "999999999" }],
	};
	const stub: typeof fetch = async () =>
		new Response(JSON.stringify(expensive), { status: 402, headers: { "content-type": "application/json" } });
	const pay = payingFetch(stub, CONFIG);
	const response = await pay("https://surp.ivc.lol/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 402);
});

test("a challenge on an unsupported network passes through unsigned", async () => {
	const solana = {
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
	};
	const stub: typeof fetch = async () =>
		new Response(JSON.stringify(solana), { status: 402, headers: { "content-type": "application/json" } });
	const pay = payingFetch(stub, CONFIG);
	const response = await pay("https://surp.ivc.lol/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 402);
});

test("a paid retry that also returns 402 is returned, never retried again", async () => {
	let callCount = 0;
	const stub: typeof fetch = async () => {
		callCount += 1;
		return challengeResponse();
	};
	const pay = payingFetch(stub, CONFIG);
	const response = await pay("https://surp.ivc.lol/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 402);
	assert.equal(callCount, 2);
});

test("a non-402 first response passes straight through", async () => {
	let callCount = 0;
	const stub: typeof fetch = async () => {
		callCount += 1;
		return okResponse();
	};
	const pay = payingFetch(stub, CONFIG);
	const response = await pay("https://api.surplusintelligence.ai/v1/models");
	assert.equal(response.status, 200);
	assert.equal(callCount, 1);
});

test("the retry re-sends the identical request body bytes", async () => {
	const bodies: string[] = [];
	const stub: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		bodies.push(await request.text());
		return bodies.length === 1 ? challengeResponse() : okResponse();
	};
	const pay = payingFetch(stub, CONFIG);
	const body = JSON.stringify({ model: "surp/value", messages: [{ role: "user", content: "ping" }] });
	await pay("https://surp.ivc.lol/v1/chat/completions", { method: "POST", body });
	assert.equal(bodies.length, 2);
	assert.equal(bodies[0], body);
	assert.equal(bodies[1], body);
});

test("a 402 from a host outside the allowlist passes through unsigned", async () => {
	let signCount = 0;
	const countingSigner = new Proxy(wallet, {
		get(target, prop, receiver) {
			if (prop === "signTypedData") signCount += 1;
			return Reflect.get(target, prop, receiver);
		},
	});
	const stub: typeof fetch = async () => challengeResponse();
	const pay = payingFetch(stub, { ...CONFIG, signer: countingSigner, allowedHosts: ["surp.ivc.lol"] });
	const response = await pay("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 402);
	assert.equal(signCount, 0);
});

test("an allowlisted host pays; the default set covers surp and surplus", async () => {
	const stub: typeof fetch = async () => challengeResponse();
	const pay = payingFetch(stub, { ...CONFIG, allowedHosts: ["surp.ivc.lol", "api.surplusintelligence.ai"] });
	for (const url of [
		"https://surp.ivc.lol/v1/chat/completions",
		"https://api.surplusintelligence.ai/v1/chat/completions",
	]) {
		const calls: (string | null)[] = [];
		const counting: typeof fetch = async (input, init) => {
			calls.push(new Request(input, init).headers.get("x-payment"));
			return calls.length === 1 ? challengeResponse() : okResponse();
		};
		const response = await payingFetch(counting, { ...CONFIG, allowedHosts: ["surp.ivc.lol", "api.surplusintelligence.ai"] })(url, { method: "POST", body: "{}" });
		assert.equal(response.status, 200, url);
		assert.ok(calls[1], `paid retry for ${url}`);
	}
	void stub; void pay;
});

test("an empty allowlist pays nothing, even with a valid challenge", async () => {
	const stub: typeof fetch = async () => challengeResponse();
	const pay = payingFetch(stub, { ...CONFIG, allowedHosts: [] });
	const response = await pay("https://surp.ivc.lol/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 402);
});
