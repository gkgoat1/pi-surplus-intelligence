/**
 * Wallet resolution for x402 payments.
 *
 * The wallet's private key uses the same config-value syntax as provider API
 * keys (src/provider-config.ts): a literal, a `$VAR` environment template, or
 * a `!command` whose stdout is the key. Key material is never logged; only
 * the derived address is safe to show.
 *
 * Resolution is deliberately separate from the hook so Phase 4's config
 * surface can grow (per-day ceilings, allowlists) without touching the
 * payment flow.
 */
import { execFileSync } from "node:child_process";
import { Wallet, type Signer } from "ethers";
import { expandEnvTemplate } from "../provider-config.ts";

export type WalletSource =
	| { ok: true; signer: Signer; address: string }
	| { ok: false; reason: string };

export type ResolveWalletDeps = {
	env?: Record<string, string | undefined>;
	exec?: (command: string) => string;
};

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

function signerFromKey(privateKey: string): WalletSource {
	const trimmed = privateKey.trim();
	if (!PRIVATE_KEY_RE.test(trimmed)) {
		return { ok: false, reason: "wallet key is not a 0x-prefixed 32-byte hex string" };
	}
	try {
		const wallet = new Wallet(trimmed);
		return { ok: true, signer: wallet, address: wallet.address };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `wallet key rejected: ${detail}` };
	}
}

/**
 * Resolve a wallet from a config value (literal, `$VAR`, or `!command`),
 * falling back to the `X402_WALLET_KEY` environment variable. Resolution
 * failures never throw; payments simply stay disabled.
 */
export function resolveWallet(configured: string | undefined, deps: ResolveWalletDeps = {}): WalletSource {
	const env = deps.env ?? process.env;
	let candidate: string | undefined;

	if (typeof configured === "string" && configured.trim().length > 0) {
		if (configured.startsWith("!")) {
			try {
				const shell = env.SHELL || "/bin/sh";
				const exec =
					deps.exec ??
					((command: string) =>
						execFileSync(shell, ["-c", command], {
							encoding: "utf8",
							timeout: 5_000,
							stdio: ["ignore", "pipe", "pipe"],
						}));
				candidate = exec(configured.slice(1)).trim();
				if (candidate.length === 0) return { ok: false, reason: "wallet command produced no output" };
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return { ok: false, reason: `wallet command failed: ${detail}` };
			}
		} else {
			candidate = configured.includes("$") ? expandEnvTemplate(configured, env) : configured;
			if (candidate === undefined) {
				return { ok: false, reason: "wallet config references an unset environment variable" };
			}
		}
	} else {
		candidate = env.X402_WALLET_KEY;
	}

	if (!candidate) {
		return { ok: false, reason: "no wallet configured (set X402_WALLET_KEY or payments.wallet.privateKey)" };
	}
	return signerFromKey(candidate);
}
