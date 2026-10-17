# @hush/mcp

An MCP server that lets any MCP-capable agent — Claude Desktop, Claude Code, Cursor — pay x402 APIs **privately** with
Hush. Ask Claude "get me the AVAX signal" and it pays the provider with hush-credit: an encrypted eERC top-up when
credit runs low, otherwise an off-chain signed voucher. Observers learn neither the amount nor how often it paid.

| Tool | What it does |
|---|---|
| `hush_pay(url, maxPrice?)` | Fetch a paid endpoint via hush-credit. Refuses above `maxPrice` (default $0.10) and never falls back to a public payment. |
| `hush_balance()` | Public USDC, private hUSDC (decrypted locally) and prepaid credit per provider. |
| `hush_history(limit?)` | The agent's own payment history: calls, private top-ups (with provider-signed receipts), refunds. |
| `hush_verify()` | Proves settled vouchers are inside Merkle roots the provider committed to HushLedger. |
| `hush_refund(provider)` | Private refund of unspent credit, decrypted and checked locally. |
| `hush_freeze(agent)` / `hush_unfreeze(agent)` | Owner kill switch in HushRegistry (needs the owner key). |

**v2: trading and Proof of Alpha.** These need the Hush Desk (`DESK_URL`, default :4023) and the v2 contracts.

| Tool | What it does |
|---|---|
| `hush_quote(ticker, side, shares)` | A firm, desk-signed price (~15 s). Nothing is paid. |
| `hush_trade(ticker, side, shares, limitPrice?)` | Buy with hush-rfq: a voucher against encrypted desk credit, topped up privately in fixed chunks. Sell with a signed order; proceeds go to desk credit. The desk custodies the position. TradePolicy (per-trade max, position max, daily cap) is checked before signing. |
| `hush_positions()` | Desk-signed custody statements marked at the oracle, desk credit and settle-outs. Also audits the desk: statements must equal the agent's own fills and settle-outs. |
| `hush_settle(ticker, shares)` | Delivers custodied shares as one private eERC transfer at the desk's next batch tick. |
| `hush_verify_provider(url)` | Verifies a signal provider's Proof of Alpha against HushAlpha chain heads and the oracle before you pay. Claims are ignored. |
| `hush_prove_me()` | The agent's own trade report: every desk-signed fill and statement, each fill tied to its voucher and that voucher's HushLedger Merkle proof. The report is verified and saved to `.data/trade-report-*.json` to hand to whoever you choose. Omitted trades show as gaps in the desk's statement numbering. |

## Claude Desktop

Edit `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`, macOS: `~/Library/Application Support/Claude/`) —
see [`claude_desktop_config.example.json`](./claude_desktop_config.example.json):

```json
{
  "mcpServers": {
    "hush": {
      "command": "node",
      "args": ["D:\\project1\\Hush\\packages\\mcp\\bin\\hush-mcp.mjs"],
      "env": { "HUSH_NETWORK": "fuji", "HUSH_AGENT_ROLE": "VEIL", "HUSH_DAILY_CAP_USD": "2.00" }
    }
  }
}
```

Restart Claude Desktop, then try: *"Get me the latest AVAX signal from http://localhost:4021/api/feed and tell me what
you paid."* Claude calls `hush_pay`; `hush_balance` and `hush_history` show what only you can see.

## Claude Code

```sh
claude mcp add hush -- node D:\project1\Hush\packages\mcp\bin\hush-mcp.mjs
```

## Configuration

Keys and addresses come from the repo-root `.env` and `packages/contracts/deployments/<network>.json`.

| Env | Default | |
|---|---|---|
| `HUSH_NETWORK` | `fuji` | `localhost` for a hardhat node |
| `HUSH_AGENT_ROLE` | `VEIL` | which `.env` key pays (`<ROLE>_PRIVATE_KEY`) |
| `HUSH_DAILY_CAP_USD` | `2.00` | spend policy, enforced before anything is signed |
| `HUSH_MAX_PRICE_USD` | `0.10` | default per-call cap for `hush_pay` |
| `HUSH_STORE` | `packages/mcp/.data/…` | the agent's private history file |
| `HUSH_MAX_TRADE_USD` | `25` | TradePolicy: max notional per buy |
| `HUSH_MAX_POSITION_SHARES` | `0.50` | TradePolicy: max custodied position per ticker |
| `HUSH_DAILY_TRADE_CAP_USD` | `200` | TradePolicy: max buy notional per UTC day |
| `HUSH_MIN_WIN_RATE` / `HUSH_MIN_CALLS` | `0.4` / `10` | what `hush_verify_provider` requires to pass |
| `DESK_URL` | `http://localhost:4023` | the Hush Desk |

One signer per agent key at a time. The MCP server and an agent process using the same key (e.g. both VEIL) keep
separate stores, so each one's trade report only covers its own trades and shows the other's statements as gaps.

Only providers registered in HushRegistry are paid. The server writes nothing to stdout except MCP JSON-RPC (the eERC
SDK's logging is redirected to stderr). Test it without a host: `pnpm --filter @hush/mcp smoke` (add `--local`).
