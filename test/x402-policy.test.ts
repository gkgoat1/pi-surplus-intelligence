import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Wallet } from "ethers";
import { loadPaymentsFileConfig } from "../src/provider-config.ts";
import { writerLedger, type LedgerEntry } from "../src/x402/ledger.ts";
import { payingFetch } from "../src/x402/pay.ts";

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

const challengeResponse = () =>
	new Response(JSON.stringify(CHALLENGE), { status: 402, headers: { "content-type": "application/json" } });

function makeLedger(): { ledger: ReturnType<typeof writerLedger>; entries: LedgerEntry[] } {
	const entries: LedgerEntry[] = [];
	const ledger = writerLedger((line) => entries.push(JSON.parse(line)));
	return { ledger, entries };
}

function configWith(overrides: Record<string, unknown>, entries: LedgerEntry[]) {
	return {
		signer: wallet,
		maxPerRequestUsdc: 0.25,
		ledger: makeLedgerWith(entries),
		...overrides,
	} as Parameters<typeof payingFetch>[1];
}

function makeLedgerWith(entries: LedgerEntry[]) {
	return writerLedger((line) => entries.push(JSON.parse(line)));
}

const URL_SURP = "https://surp.ivc.lol/v1/chat/completions";

// --- payments config section ---

test("a full payments section parses into config", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-x402-config-"));
	try {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "surplus-intelligence.json"),
			JSON.stringify({
				payments: {
					wallet: { privateKey: "$X402_WALLET_KEY" },
					maxPerRequestUsdc: 0.25,
					maxPerDayUsdc: 5,
					allowedHosts: ["surp.ivc.lol"],
				},
			}),
		);
		const { payments, diagnostics } = loadPaymentsFileConfig(cwd);
		assert.deepEqual(diagnostics, []);
		assert.equal(payments?.privateKey, "$X402_WALLET_KEY");
		assert.equal(payments?.maxPerRequestUsdc, 0.25);
		assert.equal(payments?.maxPerDayUsdc, 5);
		assert.deepEqual(payments?.allowedHosts, ["surp.ivc.lol"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a missing payments section yields no config and no diagnostics", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-x402-config-"));
	try {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "surplus-intelligence.json"), JSON.stringify({ providers: {} }));
		const { payments, diagnostics } = loadPaymentsFileConfig(cwd);
		assert.equal(payments, undefined);
		assert.deepEqual(diagnostics, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("malformed payment values warn and are dropped", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-x402-config-"));
	try {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "surplus-intelligence.json"),
			JSON.stringify({ payments: { maxPerRequestUsdc: "lots", unknownField: 1 } }),
		);
		const { payments, diagnostics } = loadPaymentsFileConfig(cwd);
		assert.equal(payments?.maxPerRequestUsdc, undefined);
		assert.ok(diagnostics.some((d) => d.includes("maxPerRequestUsdc")));
		assert.ok(diagnostics.some((d) => d.includes("unknownField")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// --- policy enforcement with ledger ---

test("a challenge above the request ceiling is refused with a recorded reason", async () => {
	const entries: LedgerEntry[] = [];
	const stub: typeof fetch = async () => challengeResponse();
	const pay = payingFetch(stub, configWith({ maxPerRequestUsdc: 0.001 }, entries));
	const response = await pay(URL_SURP, { method: "POST", body: "{}" });
	assert.equal(response.status, 402);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].outcome, "refused");
	assert.equal(entries[0].reason, "over-request-ceiling");
	assert.equal(entries[0].host, "surp.ivc.lol");
});

test("a non-allowlisted host is refused with a recorded reason", async () => {
	const entries: LedgerEntry[] = [];
	const stub: typeof fetch = async () => challengeResponse();
	const pay = payingFetch(stub, configWith({ allowedHosts: ["other.example"] }, entries));
	await pay(URL_SURP, { method: "POST", body: "{}" });
	assert.equal(entries[0].reason, "host-not-allowed");
});

test("a bare 402 records unparseable-challenge; an unsupported network records unsupported-challenge", async () => {
	const entries: LedgerEntry[] = [];
	const bareStub: typeof fetch = async () => new Response("{}", { status: 402 });
	await payingFetch(bareStub, configWith({}, entries))(URL_SURP, { method: "POST", body: "{}" });
	assert.equal(entries[0].reason, "unparseable-challenge");

	const solanaStub: typeof fetch = async () =>
		new Response(
			JSON.stringify({
				x402Version: 2,
				accepts: [
					{
						scheme: "exact",
						network: "solana:mainnet",
						asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
						amount: "10000",
						payTo: "x",
						maxTimeoutSeconds: 60,
					},
				],
			}),
			{ status: 402, headers: { "content-type": "application/json" } },
		);
	await payingFetch(solanaStub, configWith({}, entries))(URL_SURP, { method: "POST", body: "{}" });
	assert.equal(entries[1].reason, "unsupported-challenge");
});

test("a settled payment records amount and tx, and accrues the daily total", async () => {
	const entries: LedgerEntry[] = [];
	let n = 0;
	const receipt = Buffer.from(JSON.stringify({ transaction: "0xtxhash" })).toString("base64");
	const stub: typeof fetch = async () => {
		n += 1;
		return n % 2 === 1
			? challengeResponse()
			: new Response("{\"ok\":true}", { status: 200, headers: { "payment-response": receipt } });
	};
	const dailySpend = { dateUtc: "", spentUsdc: 0 };
	const config = { ...configWith({ dailySpend, maxPerDayUsdc: 0.02 }, entries) };
	const pay = payingFetch(stub, config);
	await pay(URL_SURP, { method: "POST", body: "{}" });
	assert.equal(entries[0].outcome, "settled");
	assert.equal(entries[0].amountAtomic, "10000");
	assert.equal(entries[0].usdc, 0.01);
	assert.equal(entries[0].tx, "0xtxhash");
	assert.equal(dailySpend.spentUsdc, 0.01);

	// Second payment (0.01) fits the 0.02 day ceiling; a third would not.
	await pay(URL_SURP, { method: "POST", body: "{}" });
	const refused = await pay(URL_SURP, { method: "POST", body: "{}" });
	assert.equal(refused.status, 402);
	assert.equal(entries[2].reason, "over-day-ceiling");
});

test("an X-Cost header on an unpaid response is recorded as an observation", async () => {
	const entries: LedgerEntry[] = [];
	const stub: typeof fetch = async () =>
		new Response("{\"ok\":true}", { status: 200, headers: { "x-cost": "0.0042" } });
	const pay = payingFetch(stub, configWith({}, entries));
	const response = await pay("https://api.ruvicode.com/v1/chat/completions", { method: "POST", body: "{}" });
	assert.equal(response.status, 200);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].outcome, "observed");
	assert.equal(entries[0].usdc, 0.0042);
});

test("a throwing ledger writer never breaks the payment flow", async () => {
	let n = 0;
	const stub: typeof fetch = async () => {
		n += 1;
		return n === 1 ? challengeResponse() : new Response("{\"ok\":true}", { status: 200 });
	};
	const pay = payingFetch(stub, {
		signer: wallet,
		maxPerRequestUsdc: 0.25,
		ledger: writerLedger(() => {
			throw new Error("disk full");
		}),
	});
	const response = await pay(URL_SURP, { method: "POST", body: "{}" });
	assert.equal(response.status, 200);
});
