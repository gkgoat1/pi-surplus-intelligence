# Task 3 — Sign an EIP-3009 authorization with an ethers Wallet

## 1. Where this task sits

- **Phase 1 Probe every host, then pay one request**.
- **This task moves R-2 Pay valid x402 challenges with an ethers.js wallet**
  into place: the signing half of the payment flow, proven against a recorded
  Surp challenge.
- **Starts after**: nothing (parallel with Tasks 1–2, but sequence after them
  for a linear walk). **Waits on it**: Task 4 Build the 402 → policy → sign →
  retry loop.

## 2. What the developer needs to know

**Read first**

- `docs/plans/x402-fetch-hook.md` §R-2 — the domain, the timeout rule, the
  nonce rule.
- `src/provider-config.ts` — the `expandEnvTemplate` / `!command` resolution
  this task reuses for wallet material (import, don't duplicate).
- `package.json` — `ethers` v6 is a new runtime dependency; add it here.

**Settled**

- ethers v6 only: `Wallet`, `signTypedData`, `randomBytes`/`hexlify`. No v5
  shims, no web3.js.
- Typed-data domain: name `USD Coin`, version `2`, chain 8453, verifying
  contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC on Base).
- `validAfter` is 0; `validBefore` is now plus the requirement's
  `maxTimeoutSeconds`; the nonce is 32 random bytes.

**Edges and seam**

- New files only: `src/x402/sign.ts`, `src/x402/requirements.ts` (the parser),
  `test/x402-sign.test.ts`. Touches `package.json` for the dependency.
- Seam: `signTransferAuthorization(signer, requirement)` and
  `parsePaymentRequirements(response)` as pure-ish functions; the signer is
  injected, the clock is injectable.

**Run**

- `npx tsx --test test/x402-sign.test.ts`, then `npm run typecheck`.

**Unknowns**

- The exact `accepts` field names Surp emits (`maxAmountRequired` vs v2 names).
  If the recorded fixture and the probe disagree, stop and say so — the parser
  must match what Surp actually sends, not the docs.
- ethers v6's `signTypedData` needs a `Signer` with a provider-less `Wallet`;
  confirm no provider is required for offline signing before assuming so.

## 3. The workflow

1. Read the plan section and `src/provider-config.ts`, then restate this task
   in one line.
2. `npm install ethers` (runtime dependency).
3. Write the failing test for case 1 (parse the recorded Surp 402 fixture).
4. Implement the parser, then cases 2–4 red-then-green.
5. Write the failing signing test (case 5) with a well-known test key.
6. Implement the signer; verify the recovered signer address equals the test
   wallet.
7. Run the test suite and typecheck.
8. Commit: one commit for the dependency, one for parser+signer.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 402 with base64 header, v1 `accepts` shape | one parsed requirement with scheme, network, asset, amount, payTo, timeout | `parsePaymentRequirements` |
| 2 | 402 with malformed header JSON | parse failure, nothing returned | `parsePaymentRequirements` |
| 3 | `accepts` with only unsupported networks (e.g. `solana`) | no usable requirement | `parsePaymentRequirements` |
| 4 | two `accepts` entries, one Base-USDC | the Base-USDC entry is chosen | `parsePaymentRequirements` |
| 5 | wallet from key `0x0000…0001`, parsed requirement from case 1 | signature recovers to `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`; `validBefore` = now + timeout; nonce is 32 bytes | `signTransferAuthorization` |
| 6 | requirement with `maxTimeoutSeconds: 30`, clock fixed at T | `validBefore` = T + 30 exactly | `signTransferAuthorization` |

The case-5 address is the well-known Hardhat/account-0 address for private key
`0x00…01` — an independent expected value, not recomputed by the code.
