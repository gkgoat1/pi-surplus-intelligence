/**
 * Production ChainDriver over an ethers v6 Signer + provider. The signer
 * holds the key material; this module only wires calls through. The address
 * is taken explicitly because `Wallet.address` is synchronous while
 * `Signer.getAddress()` is not.
 */
import type { Provider, Signer } from "ethers";

import type { ChainDriver, TxRequest } from "./types.ts";

const ERC20_BALANCE_OF = "0x70a08231"; // balanceOf(address)

export function ethersDriver(signer: Signer, provider: Provider, chainId: number, address: string): ChainDriver {
	return {
		chainId,
		address,
		getNativeBalance: (target) => provider.getBalance(target),
		getTokenBalance: async (token, target) => {
			const data = ERC20_BALANCE_OF + target.toLowerCase().replace(/^0x/, "").padStart(64, "0");
			return BigInt(await provider.call({ to: token, data }));
		},
		call: (tx) => provider.call({ to: tx.to, data: tx.data }),
		sendTransaction: async (tx: TxRequest) => {
			const sent = await signer.sendTransaction({
				to: tx.to,
				data: tx.data,
				...(tx.valueWei !== undefined ? { value: tx.valueWei } : {}),
			});
			return sent.hash;
		},
		waitForTransaction: async (hash) => {
			const receipt = await provider.waitForTransaction(hash, 1);
			if (!receipt) throw new Error(`no receipt for ${hash}`);
			return {
				status: receipt.status === 1 ? 1 : 0,
				logs: receipt.logs.map((log) => ({
					address: log.address,
					topics: [...log.topics],
					data: log.data,
				})),
			};
		},
	};
}

export default ethersDriver;
