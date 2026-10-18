# Hush — 3-minute demo script

**Goal:** in three minutes, show that x402 leaks an agent's strategy, that Hush stops it with eERC on Avalanche, and
that Hush can still prove a track record. Everything on screen is live: the stack runs locally against Fuji or a local
chain, and every number comes from the chain or from an agent's own stream.

## Before recording (T−10 min)

```sh
pnpm node                                                   # local chain (or skip and use Fuji: drop every :local)
pnpm fund:local && pnpm deploy:local && pnpm bootstrap:local
PRICE_INTERVAL_SECONDS=10 RULES_MIN_CONFIDENCE=0 AGENT_INTERVAL_SECONDS=12 pnpm demo:local
pnpm web                                                    # http://localhost:3000
```

- Let it run **≥ 8 minutes** first: Atlas and Veil need a few trades, and the providers need a few committed epochs
  before Proof of Alpha has calls to grade (60 s epochs locally, 600 s on Fuji).
- Open four tabs: `/` · `/demo` · `/console/provider` · `/console/agent`. Window ~1440×900, browser zoom 100%.
- Pre-open a terminal with `pnpm journey:local` typed but not run (optional closing shot).

## Script

| Time | Screen | Say |
|---|---|---|
| **0:00–0:20** | `/` hero, **Public** mode. Let the observer terminal tick. | "AI agents now pay per request with x402. On a public chain every payment is a receipt: payer, payee, amount, second. This observer has already worked out that this agent is a momentum bot — and when it will trade next." |
| **0:20–0:35** | Click **Drop the veil ↓** (scrolls into chapter 02 and the page flips to **Hush**) — the scene turns gold, packets go encrypted, the terminal goes quiet. | "Hush puts x402 behind eERC, Avalanche's encrypted ERC-20. Amounts are ElGamal ciphertexts; every transfer carries a Groth16 proof C-Chain verifies itself. No coprocessor, no second network." |
| **0:35–1:15** | `/demo`. Point at the two meters (Atlas **100%**, Veil **25%**), then scroll to **Mirror**: Atlas copied N/N, Veil 0/0. | "Same strategy, two agents. Atlas pays and trades publicly; Veil uses Hush. Mirror is a copycat bot that only reads the chain. It copies every Atlas trade a few seconds later. Against Veil it sees encrypted top-ups and nothing else — nothing to copy. One private top-up buys hundreds of calls: each call is a signed voucher, and the chain only sees a Merkle root every two minutes, busy or idle." |
| **1:15–1:40** | `/demo`, switch **View as → Owner**. Veil's log unseals, its top-up amounts decrypt, its position appears. Then **Auditor**. | "Private isn't opaque. The owner decrypts everything with the agent's key; the auditor key built into eERC decrypts every amount. Public, owner, auditor — compliance by design." |
| **1:40–2:15** | `/console/provider` → **Proof of Alpha**. SignalCo verified; AlphaKing claims ~90% → **✗ fails at epoch …**. Click **Verify again**. | "Hush also makes providers accountable. Every signal is signed and chained into HushAlpha every epoch. AlphaKing claims 90% but hid its losing calls — so its proof breaks at the first doctored epoch. This check runs in your browser, against the chain. Veil runs it before it pays; Atlas just trusts the claim." |
| **2:15–2:45** | `/console/agent` (Veil, Owner) → **Build & verify** → *signatures valid · complete record · anchored on-chain*, P&L. | "And the agent can prove its own record without publishing it: every desk-signed fill, tied to the voucher that paid for it, inside a Merkle root on HushLedger. The desk numbers its statements, so a hidden losing trade shows. Hand this file to an investor; they verify it in a browser." |
| **2:45–3:00** | Back to `/` → closing CTA (or the terminal running `pnpm journey:local` → *all 12 checks passed*). | "Hush: a drop-in x402 scheme, an MCP server for any agent, live on Avalanche. Private by default — provable on demand." |

## If something is off

- **Mirror shows 0/0 for Atlas** — no public trade yet; wait one more agent tick (12 s) or lower `RULES_MIN_CONFIDENCE`.
- **Proof of Alpha says "no resolved, committed epochs yet"** — the providers haven't committed enough epochs; give it a
  few more minutes (horizon = 3 epochs).
- **Owner/Auditor buttons disabled** — the operator isn't running (`pnpm demo` starts it on :4040).
- **Veil's trade report says "incomplete"** — another process traded with the same key (e.g. `desk-e2e`); on a fresh
  chain run only the demo stack, or show `pnpm journey:local`, which uses a brand-new agent.

## Judging map

| Criterion | Where it shows |
|---|---|
| Works (30%) | everything live; `pnpm journey:local` 12/12 + the e2e suites (README → Checks) |
| Idea / originality (25%) | private x402 + private trading + provable track records; Mirror as the threat model |
| Technical depth (20%) | eERC calldata PCT decryption, cumulative vouchers in Merkle roots, hash-chained Proof of Alpha with commit-deadline grading, trade reports with gapless desk statements |
| Avalanche fit (15%) | eERC converter + auditor key on C-Chain, full Fuji deployment |
| Demo (10%) | this script |
