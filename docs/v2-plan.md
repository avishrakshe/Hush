# Hush v2 — V0 audit & plan (2026-10-03)

> **Status:** V0 ✅ · V1 ✅ · V2 ✅ (desk e2e 14/14 locally and on Fuji). Built as planned. Differences from the original
> prompt: sells use `GET /quote` + `POST /sell` (D4); `POST /settle-out` replaces `/settle` (D5); position reads
> (`GET /positions/:agent`) reuse the signed credit-query header. Current state: see CLAUDE.md, v2 track.

v2 thesis: an agent's strategy leaks through **what it learns** (data), **what it does** (trades) and **what it holds**
(positions). Hush closes all three with x402 + eERC, then lets the agent **prove** its record without publishing it.
Loops: LEARN → TRADE → HOLD → PROVE. Tagline: "Private by default. Provable on demand."
Mock stock tokens on Fuji — no Dinari/Pharaoh integration is claimed.

## 1. Verified against the code

### eERC converter (vendored `packages/contracts/contracts/eerc`)
- **One converter, many ERC-20s.** `_convertFrom` (EncryptedERC.sol:617) calls `_addToken` (TokenTracker.sol:142) on the
  first deposit of any token → `tokenIds` / `tokenAddresses` / `tokenDecimals` (decimals captured once). Registration is
  **permissionless** (no owner gate; the owner can only `setTokenBlacklist`). Ids start at 1 in first-deposit order, so
  never hardcode them — read `tokenIds(token)` after the desk's inventory deposit.
- **Balances are per (user, tokenId)** (`EncryptedUserBalances.balances`, :37). Consequences:
  - `MAX_PENDING_AMOUNT_PCTS = 300` is per **(account, token)** (`_addToUserHistory`, :194), not per account. Sweeping
    hUSDC does nothing for hNVDA.
  - The "one outgoing tx at a time" rule is also per (account, token) (balance hash + nonce per tokenId). `EercAccount`
    serializes everything anyway; keep it that way.
- **Precision.** eERC decimals = 2. An 18-dp stock deposit is scaled down by 1e16; the remainder (dust) is returned in the
  same tx (`Deposit.dust`); a deposit under 0.01 share credits nothing (EncryptedERC.sol:636–652). Withdraw scales back up
  ×1e16 (:693). ⇒ **unit = 0.01 share** ("centishare" = 1 eERC unit). `@avalabs/eerc-sdk` `deposit()` reads the token's
  `decimals()` and scales the PCT itself (src/EERC.ts in the sourcemap) — no SDK patch needed.
- **What is public:**
  - `transfer(address to, uint256 tokenId, TransferProof, uint256[7] balancePCT[, bytes])` (:368/:390): `to` and
    `tokenId` are plaintext calldata. `PrivateTransfer(from, to, auditorPCT, auditor)` (:122) has no tokenId, but the
    calldata does (our `readEercTransfer` decodes it). Only the amount is hidden.
  - `deposit(amount, tokenAddress, amountPCT)` (:423): amount + token public (ERC-20 `Transfer` +
    `Deposit(user, amount, dust, tokenId)`).
  - `withdraw(tokenId, proof, balancePCT)` (:478): amount = `publicSignals[0]`, emitted in `Withdraw`.
  - ⇒ The prompt's custody argument holds: per-trade delivery would leak asset + direction per trade.

### x402 v2 (`@x402/core@2.27.0`) — hush-rfq needs no core changes
- `PaymentOption.price` may be `DynamicPrice(ctx)` (x402Client d.mts:820/848); `ctx.paymentHeader` carries the echoed
  payment (:945). An `AssetAmount.extra` is merged into `requirements.extra` (`buildPaymentRequirements`, chunk
  :1082). ⇒ **the 402 can carry the desk-signed quote.**
- On the paid retry the server re-runs the price function and requires the core fields (amount, asset, payTo, …) to
  deep-equal the echoed `accepted`. The advertised `extra` must be a subset of the echoed one, ignoring the scheme's
  `dynamicExtraFields` (`paymentRequirementsMatchAccepted`, chunk :2046; d.mts:1715). ⇒ The retry decodes the quote from
  `paymentHeader`, checks the desk signature, expiry and that it hasn't been used, then returns the same notional. This
  works for `exact` as well.
- `FacilitatorClient` = `{verify, settle, getSupported}` (d.mts:102) ⇒ the desk can run its facilitator in-process.
- `SettleResponse.extra` reaches the client in `PAYMENT-RESPONSE` (hush-credit already uses it) ⇒ FillReceipt and
  PositionStatement ride back to the agent the same way.

### Existing Hush code that v2 must generalise (additively)
- `HushProviderService` is bound to one provider wallet. `verifyVoucher` requires scheme `hush-credit` (service.ts:262)
  and `requestHash = hash(resourceUrl)` (:266). `tokenId()` is fixed to USDC (:526), which is good: hStock can never
  count as a top-up.
- `EercAccount` hardcodes `contracts.usdc` in `balance`/`deposit`/`transfer`/`withdraw`/`decryptOutgoing`
  (account.ts:147/177/192/203/304) → add an optional `token` (default USDC).
- `apps/facilitator` is hardwired to role `PROVIDER` (index.ts:35); one facilitator per provider.
- `SpendPolicy.dailyCap` counts every payment (policy.ts:42) → trades need a separate `TradePolicy`.

### Baseline (2026-10-03)
Contracts **27 passing**; SDK **30 passing**. `pnpm e2e:local --with-expiry` was not re-run in V0.
**Fuji:** v1 stack live (`deployments/fuji.json`, MockUSDC). Deployer holds 0.196 AVAX, the other roles 0.05 each, and
fees are negligible, so the prompt's "Fuji pending faucet AVAX" is stale. v2 contracts can go to Fuji as soon as they
pass locally. New roles need a little AVAX from the deployer.

## 2. Decisions and deviations from the prompt

| # | Decision | Why |
|---|---|---|
| D1 | New `HushAlpha.sol`; **no changes to HushLedger/HushRegistry.** Domain `{name:"HushAlpha", version:"1", chainId, verifyingContract}`. Typehashes for Quote, FillReceipt, PositionStatement, SignalRecord, plus chain heads. Built and deployed at the start of V2 (quotes are signed under its domain); V4 only adds the SDK proof logic. | Keeps 27 tests and the v1 deployment intact. |
| D2 | The desk is a normal HushRegistry provider (pricePerCall 0, its own eERC key). Its facilitator runs **in-process** in `apps/desk`. `apps/facilitator` is refactored into an exported `createFacilitator({ role, … })` plus the unchanged CLI. | One process fewer; no copy of the facilitator code. |
| D3 | **hush-rfq payment = an ordinary Hush Voucher** in the agent's credit stream at the desk, with `requestHash = HushAlpha digest of the Quote`. The existing fixed-cadence voucher batches (`HushLedger.commitBatch`, dummy roots) then commit every fill: no second tree, no new leaf type. FillReceipt = the desk's signature over that quote + `filledAt`. | Binds each payment to exactly one desk-signed quote. |
| D4 | **Sells are not x402** (no money flows from the agent): `GET /quote?side=sell` → `POST /sell` carrying a **zero-increment voucher** (requestHash = quote digest) as the agent's signed order, so sells land in the same batches. Proceeds are credited off-chain: `proceedsTotal` on `CreditRecord` (drizzle migration 0001); available = credited + proceeds − refunded − settled. | A 402 for $0 is meaningless; the order still gets committed. |
| D5 | `POST /settle` → **`POST /settle-out`** (agent-signed `SettleOutRequest`). Queued and executed at the batch tick, one private hStock transfer each (desk account serialized; sweep per token before 300). | `/settle` is the x402 facilitator route in the same process. Batching blurs timing. |
| D6 | Sizes and positions are **integer centishares** (0.01 share = 1 eERC unit). Prices are USDC atomic per share; `notional = size × price / 100`. | Settle-out is always exact; no dust. |
| D7 | `commitChainHead` accepts only **the epoch that just closed** (`epoch + 1 == block.timestamp / epochLen`), instead of "== current epoch". | With "current", a leaf issued after that epoch's commit can't be in its head. Committing the closed epoch still makes back-dating impossible (≤ 1 epoch late). |
| D8 | `epochLen` is a constructor immutable: 600 s on Fuji, 60 s locally. Rule: **`horizonSec ≥ 2 × epochLen`**. The verifier reports uncommitted epochs (gaps) and discards signals whose binding commit landed after `issuedAt + horizonSec`. | Otherwise a provider could pick winners after the outcome is known. A 60 s local epoch makes AlphaKing's divergence demoable in minutes. |
| D9 | 402 metadata advertises **claimed** stats + `proofUrl`. "Verified" is only what the client computes. Customers keep every signed SignalRecord, so an omitted one is portable evidence for `flagProvider`. | A provider-advertised "verified" number is still just a claim. |
| D10 | AlphaKing = a second provider-demo instance (role `ALPHAKING`) in the **same process** as SignalCo, offering `exact` only. Veil verifies before choosing a provider (so it never pays); Atlas buys on the claim. | Avoids a third facilitator; keeps the contrast. |
| D11 | Oracle: `postPrices(bytes32[] tickers, uint256[] prices)` = 1 tx/min for all tickers; `getPriceAt` binary-searches rounds. MockStock: per-address **lifetime** faucet cap + owner `mint` for desk inventory. | Fewer txs; the desk needs inventory above the cap. |
| D12 | Memory: this machine already hit low-memory reaping. snarkjs-heavy processes stay at 4 (facilitator, desk, Veil, operator); price-bot and Mirror use viem only. `pnpm demo --only …` stays the escape hatch. | ~10 Node processes otherwise. |

## 3. New roles and ports
`DESK` (desk + in-process facilitator, :4023), `ALPHAKING` (:4025, same process as SignalCo on :4021), `MIRROR` (SSE
:4033), `PRICEBOT` (no port). SignalCo = the existing `PROVIDER`. Existing ports unchanged (facilitator 4022, Atlas 4031,
Veil 4032, operator 4040, web 3000).

## 4. Files per phase
- **V1**
  - `contracts/stocks/MockStock.sol`, `contracts/stocks/MockStockOracle.sol`
  - `scripts/lib/deployStack.ts`: incremental v2 deploy appended to `deployments/<net>.json`; v1 is never redeployed
  - `@hush/config`: new roles + optional `stocks/oracle/hushAlpha` in `loadContracts`
  - SDK generated ABIs/deployments
  - `apps/price-bot` (new)
  - `apps/provider-demo`: `GET /api/signal`
  - bootstrap: desk eERC key + provider registration, inventory deposit (registers tokenIds), faucet
  - tests: oracle rounds, faucet caps, deploy stack
- **V2**
  - `contracts/hush/HushAlpha.sol` + tests
  - SDK:
    - `constants`/`types`: `HUSH_RFQ` and the typed structs
    - `eip712`: quote/fill/statement/sell/settle-out
    - `server/rfq.ts`: DynamicPrice helper + server scheme
    - `facilitator/rfq.ts`: scheme + `HushDeskService` + `PositionStore` (memory impl)
    - `client/hushRfq.ts`: `hushQuote`, `hushTrade`, `hushSell`, `getPositions`, `settleOut`, `verifyPositions`, `TradePolicy`
    - `eerc/account.ts`: optional token
    - `service.ts`: `verifyVoucher` options + `proceedsTotal`
  - `apps/facilitator`: `createFacilitator` refactor + migration 0001
  - `apps/desk` (new)
  - tests: quote sign/expiry/replay, voucher-for-notional, statement monotonicity, sell → credit, frozen agent
- **V3**
  - `apps/agent`: same strategy for both agents (signal → decide → trade); rules + Claude brain
  - `apps/mirror` (new): public-chain watcher + copier + SSE
- **V4**
  - `packages/sdk/src/proofOfAlpha.ts`: chain build, `buildProof`, `verifyProof`
  - provider proof endpoints + chain-head committer job; Veil's own trading proof
  - tests: omission / back-date / forged sig / tampered price / heartbeat / stale window
- **V5**
  - MCP: `hush_quote`, `hush_trade`, `hush_positions`, `hush_settle`, `hush_verify_provider`, `hush_prove_me`
  - sealed telemetry for trades + positions
  - auditor CSV export (operator)
- **V6**
  - `apps/web`: landing PROVE chapter + Mirror node; `/demo` panels; `/console/agent`; `/console/provider`; `/docs`
- **V7**
  - README + CLAUDE.md
  - `e2e:local` extended: signal → verify → quote → trade → positions → sell → settle-out → proof
  - 3-min demo script

## 5. Defaults I'll use unless told otherwise
- Realistic mock prices (NVDA ≈ $180, TSLA ≈ $250, SPY ≈ $570) with fractional sizes (e.g. 0.10 share ≈ $18/trade).
  The desk's hUSDC top-up chunk is a fixed $50.
- v2 contracts deploy to Fuji at the end of V1/V2 once local tests pass (testnet only, deployer already funded).
- Fill commitments go through D3 (voucher leaves), not a separate fill tree. Change this only if judges need fill
  inclusion proofs independent of payment.
