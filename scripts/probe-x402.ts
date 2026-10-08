/**
 * x402 support probe. Sends one unauthenticated chat completion to each
 * candidate host and classifies the answer:
 *
 *   401 key-required — the host wants an API key, not a payment
 *   402 x402         — a valid x402 payment challenge is attached
 *   402 bare         — a 402 with no parseable x402 requirements (e.g. Bu0y's
 *                      insufficient-balance signal); must never be paid
 *   other            — anything else (200, 5xx, redirects)
 *
 * The probe never carries credentials: no wallet, no API key, no auth header.
 * It samples the chat-completions path only. Run it live with:
 *
 *   npx tsx scripts/probe-x402.ts [baseUrl ...]
 */

export type ProbeClassification =
	| "401 key-required"
	| "402 x402"
	| "402 bare"
	| "other";

export type ProbeResult = {
	classification: ProbeClassification;
	note?: string;
};

const REQUIREMENTS_HEADERS = ["x-payment-requirements", "payment-required"];

type AcceptsEntry = {
	scheme?: unknown;
	network?: unknown;
	maxAmountRequired?: unknown;
	asset?: unknown;
};

/** A usable v1-style accepts entry names scheme, network, amount, and asset. */
function isUsableAcceptsEntry(entry: AcceptsEntry): boolean {
	return (
		entry.scheme === "exact" &&
		typeof entry.network === "string" &&
		entry.network.length > 0 &&
		typeof entry.maxAmountRequired === "string" &&
		/^[0-9]+$/.test(entry.maxAmountRequired) &&
		typeof entry.asset === "string" &&
		entry.asset.length > 0
	);
}

function hasUsableAccepts(payload: unknown): boolean {
	if (typeof payload !== "object" || payload === null) return false;
	const accepts = (payload as { accepts?: unknown }).accepts;
	if (!Array.isArray(accepts)) return false;
	return accepts.some((entry) => isUsableAcceptsEntry(entry as AcceptsEntry));
}

type JsonObject = Record<string, unknown>;

function parseJsonObjectMaybe(text: string): JsonObject | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as JsonObject;
	} catch {
		return undefined;
	}
}

/**
 * Classify one probe response. Pure: reads status, headers, and body; performs
 * no network I/O of its own.
 */
export async function classifyProbeResponse(response: Response): Promise<ProbeResult> {
	if (response.status === 401) return { classification: "401 key-required" };
	if (response.status !== 402) return { classification: "other" };

	const bodyText = await response.text().catch(() => "");

	for (const headerName of REQUIREMENTS_HEADERS) {
		const headerValue = response.headers.get(headerName);
		if (!headerValue) continue;
		try {
			const decoded = Buffer.from(headerValue, "base64").toString("utf8");
			if (hasUsableAccepts(parseJsonObjectMaybe(decoded))) {
				return { classification: "402 x402", note: `challenge in ${headerName} header` };
			}
		} catch {
			// Undecodable header: fall through to the body check.
		}
	}

	if (hasUsableAccepts(parseJsonObjectMaybe(bodyText))) {
		return { classification: "402 x402", note: "challenge in JSON body" };
	}
	return { classification: "402 bare" };
}

const DEFAULT_HOSTS: { name: string; chatCompletionsUrl: string; model: string }[] = [
	{ name: "surp", chatCompletionsUrl: "https://surp.ivc.lol/v1/chat/completions", model: "surp/value" },
	{ name: "bu0y", chatCompletionsUrl: "https://api.bu0y.com/v1/chat/completions", model: "glm4.6" },
	{ name: "surplus-intelligence", chatCompletionsUrl: "https://api.surplusintelligence.ai/v1/chat/completions", model: "kimi-k2.7-code" },
	{ name: "openrouter", chatCompletionsUrl: "https://openrouter.ai/api/v1/chat/completions", model: "openai/gpt-4o-mini" },
];

const PROBE_TIMEOUT_MS = 15_000;

async function probeOne(host: { name: string; chatCompletionsUrl: string; model: string }): Promise<ProbeResult> {
	// SSRF guard: the probe only ever POSTs to http(s) URLs. CLI-supplied URLs
	// are validated in main(); the defaults above are compile-time constants.
	if (!/^https:\/\//.test(host.chatCompletionsUrl)) {
		return { classification: "other", note: "refused: not an https URL" };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(host.chatCompletionsUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: host.model,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
			}),
			signal: controller.signal,
		});
		return await classifyProbeResponse(response);
	} catch (error) {
		if (controller.signal.aborted) return { classification: "other", note: `timeout after ${PROBE_TIMEOUT_MS}ms` };
		const detail = error instanceof Error ? error.message : String(error);
		return { classification: "other", note: `unreachable: ${detail}` };
	} finally {
		clearTimeout(timer);
	}
}

async function main(): Promise<void> {
	const extraUrls = process.argv.slice(2);
	const extraHosts: { name: string; chatCompletionsUrl: string; model: string }[] = [];
	for (const url of extraUrls) {
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "https:") throw new Error("https URLs only");
			extraHosts.push({
				name: parsed.hostname,
				chatCompletionsUrl: `${url.replace(/\/$/, "")}/chat/completions`,
				model: "probe",
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`skipping ${url}: ${detail}`);
		}
	}
	const hosts = [...DEFAULT_HOSTS, ...extraHosts];
	for (const host of hosts) {
		const result = await probeOne(host);
		const note = result.note ? ` (${result.note})` : "";
		console.log(`${host.name}\t${host.chatCompletionsUrl}\t${result.classification}${note}`);
	}
}

// Run only when executed directly, not when imported by tests. Guard the
// URL conversion: a malformed argv[1] must not crash an import.
try {
	const invokedAs = process.argv[1] ? new URL(`file://${process.argv[1]}`).pathname : "";
	if (invokedAs.endsWith("probe-x402.ts") || invokedAs.endsWith("probe-x402")) {
		await main();
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
