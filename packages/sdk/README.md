# @hush/x402

Private x402 payments for AI agents on Avalanche. Adds two x402 v2 schemes on top of the official
`@x402/*` packages, using eERC (Encrypted ERC, converter mode):

| Scheme | Per call | On-chain footprint | Hides |
|---|---|---|---|
| `exact` (standard x402) | EIP-3009 transfer | every call, with amount | nothing |
| `hush-direct` (reference) | eERC private transfer (~5 s proof) | every call, amount encrypted | amounts |
| **`hush-credit`** | signed EIP-712 voucher (~0.1 s) | occasional encrypted top-ups + Merkle roots | amounts, call frequency, per-call pattern |

## Agent

```ts
import { EercAccount } from "@hush/x402";
import { createHushFetch } from "@hush/x402/client";

const eerc = new EercAccount({ publicClient, walletClient, contracts, circuits }); // agent wallet
const hush = createHushFetch({
  mode: "hush-credit",
  wallet: account,                       // viem LocalAccount — signs vouchers
  eercClient: eerc,
  publicClient,
  policy: { maxPerCall: 50_000n, dailyCap: 5_000_000n, allowedProviders: [provider] }, // USDC atomic
  privacy: { topUpChunks: [5_000_000n, 10_000_000n], jitterMs: [5_000, 60_000] },
});
const res = await hush.fetch("https://provider.example/api/feed");
await hush.credit?.verifyMyVouchers();   // checks inclusion against HushLedger
await hush.credit?.requestRefund(provider);
```

A private agent never silently falls back to a public payment (`allowFallback` defaults to `false`).

## Provider (one line)

```ts
import { hushMiddleware } from "@hush/x402/server";
app.use(hushMiddleware({ payTo, contracts, facilitatorUrl, routes: { "GET /api/feed": { price: "$0.02" } } }));
```

## Facilitator

`HushProviderService` + `HushCreditFacilitatorScheme` / `HushDirectFacilitatorScheme` plug into
`x402Facilitator` from `@x402/core/facilitator`. Bring a `CreditStore` (a `MemoryCreditStore` is included; the
reference app uses SQLite). See `apps/facilitator` in the Hush repo.

## Trust model

hush-credit prepays the provider, so the provider is trusted for the unspent balance. Mitigations: provider-signed
`CreditReceipt`s (verifiable on HushLedger), Merkle commitments of every consumed voucher, private refunds on request,
automatic refunds after the credit TTL, and public `flagProvider` with signed evidence. eERC hides amounts and
balances, not addresses: top-up sender/receiver are visible.

## Keys

The eERC key is derived from a wallet signature (as eERC registration does), so the wallet is the primary backup.
`exportKeyBackup` / `importKeyBackup` produce a passphrase-encrypted backup. Losing both means the encrypted balance
is unrecoverable. Use one process per eERC account: outgoing eERC transfers must be sequential.

## Notes

- `@avalabs/eerc-sdk` imports React and wagmi at module load, so they are runtime dependencies here even for
  headless Node use. Its `package.json` `main` points to an unpublished `.cjs` file; this package deep-imports the ESM
  build instead.
- Licensed MIT. eERC contracts and circuits are Ava Labs Ecosystem License (Avalanche-only).
