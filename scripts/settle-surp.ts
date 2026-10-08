/**
 * Settle one live x402 payment against Surp. Manual use only — never wired
 * into the test suite.
 *
 *   X402_TEST_KEY=0x… npx tsx scripts/settle-surp.ts           # one paid call
 *   X402_TEST_KEY=0x… npx tsx scripts/settle-surp.ts --check   # print address, send nothing
 *
 * The wallet key comes from the environment (or swap the resolution below for
 * a `!command`-style keychain read). It is never written to disk or logged.
 * The script sends one `surp/value` chat completion with `max_tokens: 1`
 * through the paying fetch, and prints the outcome: HTTP status, whether a
 * payment was attached, and the settlement receipt Surp returns.
 */
import { Wallet } from "ethers";
import { payingFetch } from "../src/x402/pay.ts";

const SURP_CHAT_URL = "https://surp.ivc.lol/v1/chat/completions";
const MAX_PER_REQUEST_USDC = 0.25;

function resolveWallet(): Wallet {
	const key = process.env.X402_TEST_KEY;
	if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
		console.error("Set X402_TEST_KEY to a 0x-prefixed 32-byte private key for a wallet holding USDC on Base.");
		process.exit(1);
	}
	return new Wallet(key);
}

function paymentReceiptOf(response: Response): string | undefined {
	// Surp settles through a facilitator and reports the result; v2 names the
	// receipt header `payment-response`, v1 used `x-payment-response`.
	const header = response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
	if (!header) return undefined;
	try {
		const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
		const tx = decoded.transaction ?? decoded.txHash ?? decoded.hash;
		return typeof tx === "string" ? tx : JSON.stringify(decoded);
	} catch {
		return header;
	}
}

async function main(): Promise<void> {
	const checkOnly = process.argv.includes("--check");
	const wallet = resolveWallet();
	console.log(`wallet: ${wallet.address}`);
	if (checkOnly) {
		console.log("--check: wallet loaded, nothing sent.");
		return;
	}

	const pay = payingFetch(fetch, { signer: wallet, maxPerRequestUsdc: MAX_PER_REQUEST_USDC });
	const response = await pay(SURP_CHAT_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "surp/value",
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 1,
		}),
	});
	const receipt = paymentReceiptOf(response);
	console.log(`status: ${response.status}`);
	console.log(`settlement: ${receipt ?? "(none — no payment was made or none reported)"}`);
	const text = await response.text();
	console.log(`body: ${text.slice(0, 400)}`);
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
