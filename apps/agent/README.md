# @hush/agent

Two autonomous agents from one codebase, with the same goal — buy AVAX/USD data when it's worth it and publish a
trading signal — and different payment rails:

| | Atlas | Veil |
|---|---|---|
| Pays with | public x402 `exact` (EIP-3009) | `hush-credit` |
| On-chain footprint | every purchase: payer, payee, amount, timing | occasional encrypted top-ups + Merkle roots |
| Telemetry (`:4031` / `:4032` `/events`) | plaintext | sealed to the owner's and auditor's eERC keys |

Each tick, Claude (`claude-sonnet-5`, tool use: `buy_price_feed`, `publish_signal`, `wait`) decides whether fresh data
is worth its price given the budget and how stale the last Chainlink round is. Without Anthropic credentials the agent
falls back to a deterministic rules brain so the payment pipeline stays demoable.

```sh
pnpm atlas            # or: pnpm veil     (add :local for a hardhat node)
pnpm reveal veil --as owner      # decrypt Veil's sealed telemetry locally (also: --as auditor)
pnpm treasury status             # owner treasury: private balance + per-agent allocations, decrypted locally
pnpm treasury allocate veil 10   # private transfer to an agent
pnpm treasury fund-credit veil 5 # buy hush-credit for an agent straight from the treasury (encrypted memo)
```

Env: `ANTHROPIC_API_KEY`, `AGENT_BRAIN=claude|rules`, `AGENT_MODEL` (default `claude-sonnet-5`), `AGENT_EFFORT`
(default `low`), `AGENT_INTERVAL_SECONDS` (30), `AGENT_DAILY_CAP_USD` (1.00), `AGENT_MAX_PER_CALL_USD` (0.05),
`FEED_URL`. Agents only pay providers registered in HushRegistry.
