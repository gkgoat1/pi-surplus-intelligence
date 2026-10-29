/**
 * Funding module barrel (plan: gkgoat-worker docs/plans/
 * x402-autofund-vm-relay-plan.md).
 */
export { autofund, DEFAULT_FUNDING_CONFIG } from "./autofund.ts";
export type { AutofundDeps, FundingConfig, FundingReport, RouteAttempt } from "./autofund.ts";
export { buildSwapTx, quoteSwap, quoteWithSlippage, executeSwapBatches } from "./swap.ts";
export {
	buildApproveTx,
	buildDepositForBurnTx,
	buildReceiveMessageTx,
	messageFromReceipt,
	fetchAttestation,
	bridgeToBase,
} from "./bridge.ts";
export { CHAINS } from "./types.ts";
export type { ChainContracts, ChainDriver, ChainRef, TxReceipt, TxRequest } from "./types.ts";
