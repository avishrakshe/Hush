# Hush — private x402 payments for AI agents on Avalanche

AI agents pay for APIs without leaking their strategy. Payments are encrypted with eERC (Encrypted ERC,
converter mode) on Avalanche; only the agent's owner (and an optional auditor) can see amounts.

Built for the Avalanche Speedrun "Build Anything on Avalanche" cycle. **Submissions close 21 Oct 2026.**
Judging: works 30%, idea/originality 25%, technical depth 20%, Avalanche fit 15%, demo 10%. Bonus: mainnet
deployment, own L1, meaningful eERC/ICM/ICTT use, open-sourcing something reusable.

## Working rules
- Work phase by phase (P1–P7 below). **Stop after each phase**, show what to run and how to verify.
- Never invent SDK APIs — read the source/README first and say what you found.
- Secrets live in `.env` (gitignored). Testnet keys only.
- Tests for contracts, voucher verification, receipt verification.
- Short comments on non-obvious decisions (the user defends them in judges' Q&A).
- hush-direct is a reference implementation only; **hush-credit is the product**.
- Out of scope: provider discovery / marketplace UI.

## Schemes
1. **`exact` (public baseline)** — standard x402 v2 `exact` via `@x402/evm` (EIP-3009 `transferWithAuthorization`
   settled by a facilitator). Fully visible.
2. **`hush-direct`** — each call is an eERC private transfer. Amounts hidden, slow (Groth16 proof per call).
3. **`hush-credit`** — one private eERC top-up to the provider, then each call carries a signed EIP-712
   cumulative voucher off-chain. On-chain: occasional encrypted top-ups + Merkle batch roots only.
   Conceptually a **private variant of x402's official `batch-settlement` scheme**.

### Credit-mode flow
1. Owner deposits USDC → encrypted hUSDC (eERC converter). Owner privately funds agents (treasury).
2. Agent `GET /api/feed` → 402 with `PAYMENT-REQUIRED` (x402 v2) listing `hush-credit` requirements
   (`provider, pricePerCall, minTopUp, facilitator`).
3. Agent sends a private eERC transfer (top-up) to the provider (optional encrypted metadata, e.g. "credit agent X").
4. Facilitator decrypts the incoming amount with the provider key, credits the agent, returns a provider-signed
   **CreditReceipt**.
5. Each call carries a signed voucher `{agent, provider, cumulativeSpent, nonce, requestHash, expiry}`; facilitator
   checks sig, nonce monotonic, `cumulativeSpent ≤ credit`, expiry, agent not frozen (`HushRegistry.isFrozen`).
6. On a fixed cadence (default 2 min, **including empty/dummy batches so commit timing doesn't leak activity**),
   facilitator Merkle-izes consumed vouchers → `HushLedger.commitBatch(provider, batchId, root)`. Agent SDK keeps
   its vouchers and verifies inclusion.
7. Unused credit refundable privately; credit expires after 7 days.

### Who sees what
Public: ciphertext, sender/receiver addresses of top-ups, Merkle roots. Owner: decrypts agent history with the
agent's eERC key. Auditor: eERC contract-level auditor key decrypts every amount.

### Related work (README must be precise)
- **x402 `batch-settlement`** (official, x402-foundation): escrow-backed payment channels + cumulative vouchers +
  batched claims. Trustless for the client but amounts/deposits/claims are public. Hush-credit = the private version;
  trade-off: provider is trusted for prepaid credit (mitigated by receipts, Merkle commitments, refunds, flagging).
  Why no private escrow: an eERC balance can only be spent by its BabyJubJub key holder via a ZK proof; a contract
  cannot hold/spend an encrypted balance without changes to eERC.
- **x402z** (Mind Network + Zama; FHE, ERC-7984), **Fhenix** (FHE), **PrivateX402** (Nethermind; payment channels).
- Hush differs: Avalanche-native, no coprocessor/extra network (client-side zk-SNARKs + ElGamal verified on C-Chain);
  compliance built in (public/owner/auditor views); hides call frequency & per-call patterns; provider accountability;
  drop-in x402 v2 mechanism; MCP server for any LLM agent.

### Known limitations (README + demo)
- eERC hides amounts/balances, not addresses (top-up sender/receiver visible). Mitigations: few top-ups, fixed chunk
  sizes, timing jitter. Relayer / pooled payer = future work.
- Credit mode trusts the provider for prepaid balances.
- Proof generation takes seconds → credit mode.
- eERC converter deposits are public and use fixed randomness (balance only becomes confidential after a private
  transfer is received). eERC address registration is one-time (no key rotation; wallet = key backup).

## Verified technical facts (P1 research, 2026-09-28)
- eERC source vendored from `ava-labs/EncryptedERC@8dc98cd` into `packages/contracts/contracts/eerc` (Ava Labs
  **Ecosystem License** — Avalanche-only; keep `LICENSE-eERC.md`). Use **prod verifiers** (`contracts/eerc/prod`)
  with the prebuilt circuits in `packages/contracts/circuits` (trusted setup matches). eERC decimals = 2.
- Auditor must be set (`setAuditorPublicKey(registeredAddress)`, eERC owner only) before any deposit/transfer.
  Rotation = call again; auditor only sees txs made while its key was set.
- One outgoing eERC tx per account at a time (proof binds current balance). `MAX_PENDING_AMOUNT_PCTS = 300`
  unspent incoming transfers per account → facilitator must periodically spend (refund/sweep).
- Receiver decrypts a transfer: decode `transfer` calldata → `proof.publicSignals[16..22]` (receiver PCT, constrained
  by the circuit) → `EERC.decryptPCT()`. Auditor PCT = `publicSignals[25..31]` / `PrivateTransfer` event.
- SDK: **`@avalabs/eerc-sdk@1.0.2`** (viem 2 / wagmi 2; ESM-only; imports react+wagmi at top level; not
  `@avalabs/ac-eerc-sdk`). Key = derived from personal_sign of `"eERC\nRegistering user with\n Address:<lowercase>"`.
  `decryptTransaction` is sender-side; `auditorDecrypt` only scans the last 1000 blocks → own indexer.
- x402 lives at `x402-foundation/x402`; use **v2** (`@x402/core|evm|express|fetch`): headers `PAYMENT-REQUIRED`,
  `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE` (base64 JSON), network `eip155:43113`. Custom schemes plug in via
  `SchemeNetworkClient/Server/Facilitator`. `@x402/evm` knows `avalanche-fuji`.
- MCP: **`@modelcontextprotocol/server` v2** (`McpServer`, `registerTool`, Zod v4, `StdioServerTransport` from
  `@modelcontextprotocol/server/stdio`). Never write to stdout in stdio mode.
- Fuji: Circle USDC `0x5425890298aed601595a70AB815c96711a31Bc65` (EIP-3009, version "2"); Permit2 + x402 Permit2
  proxy deployed; public RPC serves historical state. Gas is ~free.

## Network
Fuji C-Chain: RPC `https://api.avax-test.network/ext/bc/C/rpc`, chainId 43113, explorer https://testnet.snowtrace.io.
Mainnet bonus (final week): `HushRegistry` + `HushLedger` on C-Chain mainnet.

## Monorepo (pnpm workspaces, TypeScript strict)
```
packages/contracts     Hardhat 2 (ethers v6). eERC (vendored) + MockUSDC (EIP-3009) + HushRegistry + HushLedger
packages/sdk           @hush/x402: x402 v2 mechanisms (hush-direct, hush-credit) + hushFetch() + hushMiddleware()
packages/mcp           @hush/mcp: MCP stdio server exposing Hush tools
apps/facilitator       Express + SQLite (Drizzle). Top-ups, credit, receipts, vouchers, refunds, Merkle batches, SSE
apps/provider-demo     GET /api/feed (AVAX price + synthetic signal); exact / hush-direct / hush-credit
apps/agent             Atlas (public) + Veil (hush-credit) agents using Claude (`claude-sonnet-5`)
apps/web               Next.js 16 + R3F + wagmi 2 + viem 2: 3D landing, /demo, consoles, /docs
```

## Contracts
**HushRegistry**: `registerProvider(name, endpoint, pricePerCall, eercPublicKey)` (key cross-checked against the eERC
Registrar when configured), `setFacilitator`, `registerAgent(agent, metadataURI, agentConsentSig)` (EIP-712 consent from
the agent prevents griefing freezes), `freezeAgent`/`unfreezeAgent` (owner kill switch), `isFrozen`,
`flagProvider(provider, evidenceHash)` (one flag per flagger/provider/evidence). Events + view getters.
**HushLedger**: `commitBatch(provider, batchId, root)` — provider or its facilitator; batchIds strictly increasing;
`verifyInclusion(provider, batchId, leaf, proof)`. No counts or amounts on-chain.
Leaf = OZ StandardMerkleTree double hash: `keccak256(bytes.concat(keccak256(abi.encode(voucherFields, signature))))`.

## SDK essentials
EIP-712 domain `{name:"Hush", version:"1", chainId, verifyingContract: HushLedger}`.
Voucher `{agent, provider, cumulativeSpent uint256, nonce uint64, requestHash bytes32, expiry uint64}` — amounts in
USDC atomic units (6 dp); 0.01 hUSDC top-up = 10_000 units.
CreditReceipt (provider-signed) `{agent, provider, creditedTotal uint256, topupTxHash bytes32, issuedAt uint64}`.
Client policy enforced before signing: daily cap, per-call max, provider allowlist. Privacy: fixed top-up chunks,
jittered top-up timing. Persist vouchers + receipts; `verifyMyVouchers()`; `requestRefund(provider)`.

## Facilitator
`POST /topup`, `POST /verify`, `POST /refund`, `GET /credit/:agent`, cron batch commit, `GET /proof/:leaf`,
`SSE /events` (topups, receipts, calls, batches, refunds, freezes). Serialize provider eERC spends; sweep before the
300-pending limit.

## Web (apps/web)
Dark, dimensional, editorial. Tokens: `--bg #05060A`, glass surfaces, `--cyan #22E6FF`, `--violet #8B5CF6`,
`--pink #FF3DA8`, `--avax #E84142` only for on-chain moments. Fonts: Space Grotesk / Inter / JetBrains Mono.
Pages: `/` 4-chapter R3F scroll scene (THE LEAK → THE VEIL → HOW IT WORKS → PROOF) with PUBLIC/HUSH toggle;
`/demo` live split screen Atlas vs Veil (real Fuji data only, owner/auditor reveal, privacy meter, kill switch);
`/console/agent`; `/console/provider`; `/docs`. 60fps target, lazy 3D, reduced-motion/mobile/no-WebGL fallbacks.

## Phases
- P1 research ✅ (2026-09-28)
- P2 contracts ✅ **on Fuji** (2026-09-29): addresses in `packages/contracts/deployments/fuji.json`, `pnpm prove:fuji`
  passes, `pnpm status` = read-only snapshot. Snowtrace verification via Routescan is slow/flaky (`verify:fuji` caps
  each contract at `VERIFY_TIMEOUT_SECONDS`; re-run until all ✔).
- P3 SDK + facilitator + provider-demo ✅ **on Fuji** (`pnpm e2e` 13/13; locally `e2e:local --with-expiry` 14/14).
  Note: e2e flags the demo provider on-chain each run (flagCount grows).
- P4 agents + treasury + MCP ✅ **on Fuji** with the rules brain. Claude brain (`claude-sonnet-5`) reaches the API but
  **the Anthropic account has no credits** (400 "credit balance is too low") → untested live.
  One signer per agent key at a time: running Veil and the MCP server (both VEIL) concurrently makes one voucher
  get rejected (separate voucher stores); the next call recovers.
  Atlas/Veil (`apps/agent`), sealed telemetry (`seal`/`unseal`: Poseidon-ECDH key wrap to owner+auditor eERC keys +
  AES-GCM), `pnpm reveal veil --as owner|auditor`, `pnpm treasury status|allocate|fund-credit|deposit`,
  `@hush/mcp` (7 tools; `pnpm mcp:smoke:local`; Claude Desktop config in `packages/mcp/README.md`).

### Local dev loop
`pnpm node` (terminal 1) → `pnpm fund:local && pnpm deploy:local && pnpm bootstrap:local` →
`pnpm facilitator:local` → `pnpm provider:local` (waits for the facilitator) → `pnpm e2e:local`.
Stop services by port (4022 facilitator, 4021 provider), never by command-line pattern.
- P4 agents (Atlas/Veil) on Fuji, owner treasury, MCP server + Claude Desktop config.
- P5 web landing 3D scene. P6 /demo + consoles + docs.
- P7 ship: README (Mermaid, addresses, Avalanche-specific, related work, limitations, pre-existing vs built-during,
  AI tools used), `.env.example`, npm-ready `@hush/x402` + `@hush/mcp`, mainnet deploy, 3-min demo script.
- Stretch (only if solid by ~day 17): agent-only L1 with tx-allowlist precompile + ICTT USDC; selective-disclosure receipts.
