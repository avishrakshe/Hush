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
- One outgoing eERC tx per account **and token** at a time (proof binds current balance). `MAX_PENDING_AMOUNT_PCTS = 300`
  unspent incoming transfers per **(account, tokenId)** → facilitator must periodically spend (refund/sweep) per token.
- Converter is multi-token: first deposit of any non-blacklisted ERC-20 registers it (permissionless `_addToken`);
  tokenIds start at 1 in first-deposit order → read `tokenIds(token)`, never hardcode. 18-dp tokens: unit = 0.01
  (scaled ×1e16, dust returned). `transfer` calldata exposes `to` + `tokenId` (asset), not the amount.
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
apps/price-bot         v2: synthetic mock-stock prices → MockStockOracle every 60 s (viem only, @hush/config/base)
apps/desk              v2: Hush Desk (:4023) — hush-rfq + exact quotes, custody, sells, settle-outs; in-process facilitator
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
**HushAlpha** (v2, `epochLen` immutable: 600 s Fuji / 60 s local): EIP-712 domain `{name:"HushAlpha", version:"1"}` with
hash + `isValid*Signature` views for Quote / FillReceipt / PositionStatement (signer = desk) and SignalRecord (signer =
provider); `commitChainHead(subject, epoch, head)` only for the epoch that just closed, once, by subject or `committerOf`.
**MockStock** (mNVDA/mTSLA/mSPY) + **MockStockOracle** (`postPrices`, `getPriceAt`) — see v2 track below.

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
300-pending limit. It is a library now (`createFacilitator({ role, committerRole, dbFile })` in `apps/facilitator/src/app.ts`);
`src/index.ts` runs it for PROVIDER, apps/desk runs one in-process for DESK (committer = DESK; wallets use viem's
nonceManager because one process sends commits, settlements and deliveries concurrently).

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
**A fresh `pnpm node` needs a fresh facilitator DB**: `apps/facilitator/.data/hush-localhost.db` outlives the chain, and
its stale credit/batch rows break e2e (UNIQUE batch_id, phantom credit, `credit_expired`). Point `FACILITATOR_DB` at a
new file (or move the old one away). `--with-expiry` needs `CREDIT_TTL_SECONDS=240 EXPIRY_INTERVAL_SECONDS=5`.
After pulling v2: `pnpm keys` adds the new role keys (existing keys are never overwritten).
v2 extras: `pnpm price-bot:local` (PRICE_INTERVAL_SECONDS=10 for tests) · `pnpm desk:local` (own DB: `DESK_DB`) ·
`pnpm desk-e2e:local` (needs price-bot + desk). The desk refuses quotes when the oracle is >600 s old.
- P4 agents (Atlas/Veil) on Fuji, owner treasury, MCP server + Claude Desktop config.
- P5 web landing 3D scene ✅ (2026-09-30): `pnpm web` → http://localhost:3000. Next 16.3.6 pinned (16.3.7 was inside
  pnpm's release-age gate). **apps/web builds with webpack (`--webpack`)**: the SDK's NodeNext `./x.js` specifiers need
  `resolve.extensionAlias`, which Turbopack lacks. Browser/server-safe ABIs + deployments: `@hush/x402/contracts`.
  Scene = one fixed R3F canvas, shader-driven (shared uniforms in `scene/layout.ts`), lazy-loaded; static backdrop for
  reduced-motion / no-WebGL2. PROOF reads Fuji live via `GET /api/proof` (view calls only, 20 s cache).
  Observer terminal on the landing is labelled "simulated"; /demo must use real data.
- P6 /demo + consoles + docs.
- P7 ship: README (Mermaid, addresses, Avalanche-specific, related work, limitations, pre-existing vs built-during,
  AI tools used), `.env.example`, npm-ready `@hush/x402` + `@hush/mcp`, mainnet deploy, 3-min demo script.
- Stretch (only if solid by ~day 17): agent-only L1 with tx-allowlist precompile + ICTT USDC; selective-disclosure receipts.

## v2 track: LEARN → TRADE → HOLD → PROVE (plan + decisions D1–D12: `docs/v2-plan.md`)
Mock stocks + oracle + paid signals → Hush Desk (`hush-rfq`: the 402 *is* the desk-signed quote; payment = a Hush
voucher whose requestHash is the quote digest) → custodied positions (signed statements, settle-out via eERC) →
Proof of Alpha (`HushAlpha.sol` chain heads, commit the just-closed epoch) + Mirror copycat demo. HushLedger/HushRegistry
stay unchanged. Commit + push after each phase.
- V0 audit & plan ✅ (2026-10-03)
- V1 ✅ (2026-10-03):
  - `MockStock` (mNVDA/mTSLA/mSPY, 18 dp, 10-share lifetime faucet per address, owner mint) and `MockStockOracle`
    (`postPrices` batch per tick, rounds stamped with `block.timestamp` — never caller time — `getPriceAt` binary search).
  - `deploy-stocks.ts` adds the stocks to a live deployment; fresh deploys include them.
  - Bootstrap step 7: PRICEBOT updater, desk eERC key + HushRegistry listing (pricePerCall 0), and desk inventory
    (500 plain + 100 deposited per ticker; tokenIds hUSDC 1, hNVDA 2, hTSLA 3, hSPY 4 in deposit order).
  - `apps/price-bot`: OU walk + momentum φ = 0.25, seed offset by on-chain round count.
  - `GET /api/signal?ticker=` ($0.02; ticker checked before the paywall; `issuedAt ≥ latest round`; horizon 1200 s on
    Fuji, 120 s locally).
  - `EercAccount` methods take an optional `token`.
  - New roles: DESK, ALPHAKING, MIRROR, PRICEBOT.
  - `@hush/config/base` is the viem-only entry (~100 MB vs ~220 MB RSS).
- V2 ✅ (2026-10-03) — Hush Desk, `hush-rfq`. Fuji: HushAlpha `0xA45c0B7F393692DC7ad6c2dA287EA8415a779079`;
  `pnpm desk-e2e` 14/14 there and locally.
  - **Flow:** `GET /rfq?ticker&side=buy&size&agent` → 402 whose `accepts` (hush-rfq + exact) carry one desk-signed Quote
    (DynamicPrice, memoized per request context). On the paid retry the echoed quote is re-checked and re-offered
    unchanged; expired or used quotes get a fresh 402.
  - **Payment:** a normal Hush voucher in the agent's desk credit stream with `requestHash = HushAlpha digest of the
    Quote`, so it lands in the desk's HushLedger batches like any voucher. Settle books the position atomically (agent
    lock → desk book lock) and returns the signed FillReceipt + PositionStatement in `SettleResponse.extra`
    (`PAYMENT-RESPONSE`).
  - **Sells:** `GET /quote?side=sell` + `POST /sell` with a zero-increment voucher as the order; proceeds go to
    `credits.proceeds_total` (migration 0001).
  - **Settle-outs:** `POST /settle-out` (agent- or owner-signed) is queued and run after the batch tick.
  - **Reads:** `GET /positions/:agent` and `/settle-outs/:agent`, signed with the credit-query header.
  - **Public `exact` path:** quote consumed in `onBeforeSettle`, plain mStock delivered in `onAfterSettle`.
  - **Custody** stays ≤ the desk's encrypted inventory.
  - **SDK:** `HushDeskService`/`MemoryDeskStore` (facilitator), `HushRfqServerScheme` + `echoedPayment` (server),
    `HushRfqClient` + `HushDeskClient` (`buy/sell/positions/settleOut/verifyPositions`) + `TradePolicy` (client).
    `createHushFetch` registers hush-rfq and the private selector prefers hush-credit, then hush-rfq.
    `toX402Policy` ignores hush-rfq (TradePolicy governs trades).
- Next: V3 agents trade + Mirror · V4 Proof of Alpha · V5 MCP + telemetry + auditor CSV · V6 web panels · V7 docs, e2e,
  demo script
