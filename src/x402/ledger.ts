/**
 * Payment ledger: one JSON line per payment event.
 *
 * The ledger is the audit trail for an autonomous wallet (plan R-7). Every
 * settled payment records host, amount, and settlement transaction; every
 * refusal records its reason; `X-Cost`-style headers on unpaid responses are
 * recorded as observations. Ledger writes never throw into the payment path:
 * a broken ledger disables recording, not payments.
 */
import { appendFileSync } from "node:fs";

export type LedgerOutcome = "settled" | "refused" | "observed";

/** Closed refusal vocabulary (docs/plans/x402-fetch-hook.md §R-7). */
export type RefusalReason =
	| "over-request-ceiling"
	| "over-day-ceiling"
	| "host-not-allowed"
	| "unsupported-challenge"
	| "unparseable-challenge";

export type LedgerEntry = {
	/** ISO timestamp. */
	ts: string;
	sessionId?: string;
	host: string;
	/** URL path, for context without logging bodies. */
	path?: string;
	amountAtomic?: string;
	usdc?: number;
	outcome: LedgerOutcome;
	reason?: RefusalReason;
	/** Settlement transaction hash, when the server reports one. */
	tx?: string;
};

export type LedgerWriter = (line: string) => void;

export type Ledger = {
	record(entry: Omit<LedgerEntry, "ts">): void;
};

/** A ledger that appends JSONL to a file. Write failures are swallowed. */
export function fileLedger(path: string): Ledger {
	return {
		record(entry) {
			try {
				appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
			} catch {
				// A broken ledger must not break payments.
			}
		},
	};
}

/** A ledger over an injected writer, for tests and embedding. */
export function writerLedger(write: LedgerWriter): Ledger {
	return {
		record(entry) {
			try {
				write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
			} catch {
				// Same isolation guarantee as the file ledger.
			}
		},
	};
}

export const NULL_LEDGER: Ledger = { record() {} };
