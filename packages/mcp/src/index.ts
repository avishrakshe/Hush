/**
 * @hush/mcp — lets any MCP-capable agent pay x402 APIs privately.
 *
 *   hush_pay(url, maxPrice?)   fetch a paid endpoint via hush-credit (private top-ups + off-chain vouchers)
 *   hush_balance()             decrypted private balance + credit per provider
 *   hush_history(limit?)       the agent's own decrypted payment history
 *   hush_verify()              prove settled vouchers were committed to HushLedger
 *   hush_refund(provider)      private refund of unspent credit
 *   hush_freeze(agent)         owner kill switch (needs the OWNER key)  ·  hush_unfreeze(agent)
 *
 * v2 — trading at the Hush Desk (hush-rfq) and Proof of Alpha:
 *   hush_quote(ticker, side, shares)        desk-signed quote, nothing paid
 *   hush_trade(ticker, side, shares, ...)   buy (voucher against private desk credit) or sell (signed order)
 *   hush_positions()                        desk-signed custody statements, checked against the agent's own fills
 *   hush_settle(ticker, shares)             custodied shares → one private eERC transfer to the agent
 *   hush_verify_provider(url)               verify a signal provider's Proof of Alpha before paying it
 *   hush_prove_me()                         the agent's own verifiable trade report (for whoever it chooses)
 *
 * Config (env or repo .env): HUSH_NETWORK=fuji|localhost, HUSH_AGENT_ROLE (default VEIL), HUSH_DAILY_CAP_USD,
 * HUSH_MAX_PRICE_USD, HUSH_STORE (history file), HUSH_MAX_TRADE_USD (25), HUSH_MAX_POSITION_SHARES (0.50),
 * HUSH_DAILY_TRADE_CAP_USD (200), HUSH_MIN_WIN_RATE (0.4), HUSH_MIN_CALLS (10), DESK_URL.
 */
import "./stdio-guard.js";
import { NETWORK, ROLES, type Role, URLS, loadContracts, publicClient, stateTag, txLink, wallet } from "@hush/config";
import {
  STOCK_TICKERS,
  buildTradeReport,
  checkProvider,
  eercToAtomic,
  formatHusdc,
  formatPrice,
  formatShares,
  freezeAgent,
  hushRegistryAbi,
  latestRound,
  mockUsdcAbi,
  parseShares,
  unfreezeAgent,
  verifyTradeReport,
} from "@hush/x402";
import { HushDeskClient, HushFacilitatorApi, createHushFetch } from "@hush/x402/client";
import { JsonFileHushStore } from "@hush/x402/node";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, formatUnits, getAddress, isAddress, parseUnits } from "viem";
import * as z from "zod/v4";

const ROLE = (process.env.HUSH_AGENT_ROLE || "VEIL").toUpperCase() as Role;
if (!ROLES.includes(ROLE)) throw new Error(`HUSH_AGENT_ROLE must be one of ${ROLES.join(", ")}`);

const contracts = loadContracts();
const agent = wallet(ROLE);
const eerc = agent.eerc(contracts);
const usd = (v: string) => parseUnits(v.replace(/^\$/, ""), 6);
/** "$6.90", "$0.02", "$0.0005" — at least cents, never drops sub-cent precision. */
const fmtUsd = (atomic: bigint | string) => {
  const [whole, frac = ""] = formatUnits(BigInt(atomic), 6).split(".");
  return `$${whole}.${frac.padEnd(2, "0")}`;
};
const fmtSigned = (atomic: bigint | string) => (BigInt(atomic) < 0n ? `-${fmtUsd(-BigInt(atomic))}` : fmtUsd(atomic));
const DAILY_CAP = usd(process.env.HUSH_DAILY_CAP_USD || "2.00");
const DEFAULT_MAX_PRICE = usd(process.env.HUSH_MAX_PRICE_USD || "0.10");
// Trading guard rails (TradePolicy, enforced by the SDK before the agent signs) — separate from the API-spend cap.
const MAX_TRADE = usd(process.env.HUSH_MAX_TRADE_USD || "25");
const MAX_POSITION = parseShares(process.env.HUSH_MAX_POSITION_SHARES || "0.50");
const DAILY_TRADE_CAP = usd(process.env.HUSH_DAILY_TRADE_CAP_USD || "200");
const ALPHA_POLICY = { minWinRate: Number(process.env.HUSH_MIN_WIN_RATE || 0.4), minCalls: Number(process.env.HUSH_MIN_CALLS || 10) };

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const DATA_DIR = path.join(PKG_DIR, ".data");
// One store per agent key: an agent process trading with the same key keeps its own, so each sees only its own fills.
const store = new JsonFileHushStore(process.env.HUSH_STORE || path.join(DATA_DIR, `mcp-${ROLE.toLowerCase()}-${NETWORK}${await stateTag()}.json`));

let ready: Promise<ReturnType<typeof createHushFetch>> | undefined;
/** Lazily derive the eERC key and build the paying fetch (first tool call), so the server starts instantly. */
function hush() {
  ready ??= (async () => {
    await eerc.init();
    const providers = (await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getProviders" })) as Address[];
    return createHushFetch({
      mode: "hush-credit",
      wallet: agent.account,
      eercClient: eerc,
      publicClient: publicClient as never,
      store,
      // Only providers registered in HushRegistry; never silently falls back to a public payment.
      policy: { dailyCap: DAILY_CAP, allowedProviders: providers },
      // The desk is a registered provider too, so the same allowlist covers where the agent may trade.
      tradePolicy: { allowedDesks: providers, maxNotionalPerTrade: MAX_TRADE, maxPosition: MAX_POSITION, dailyNotionalCap: DAILY_TRADE_CAP },
      privacy: { topUpChunks: [5_000_000n], jitterMs: [10_000, 45_000] },
    });
  })();
  return ready;
}

let deskReady: Promise<{ client: HushDeskClient; address: Address }> | undefined;
/** The Hush Desk client (hush-rfq) and the desk's address from its public page. */
function desk() {
  deskReady ??= (async () => {
    if (!contracts.stockOracle || !contracts.hushAlpha) throw new Error(`the ${NETWORK} deployment has no desk contracts (MockStockOracle / HushAlpha)`);
    const page = (await (await fetch(`${URLS.desk}/`)).json()) as { desk?: Address };
    if (!page.desk) throw new Error(`no Hush Desk at ${URLS.desk}`);
    return { client: new HushDeskClient({ deskUrl: URLS.desk, hush: await hush(), signer: agent.account }), address: getAddress(page.desk) };
  })();
  deskReady.catch(() => (deskReady = undefined)); // the desk may come up later
  return deskReady;
}

const mark = async (ticker: string) => (await latestRound(publicClient, contracts.stockOracle!, ticker)).price;

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) }],
  ...(isError ? { isError: true } : {}),
});
const guard =
  <A>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return text(`Error: ${(err as Error).message.split("\n")[0]}`, true);
    }
  };

/** Price the endpoint asks for under hush-credit, read from its 402 challenge (no payment). */
async function quote(url: string): Promise<{ amount: bigint; schemes: string[] } | null> {
  const res = await fetch(url);
  if (res.status !== 402) return null;
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) return null;
  const { accepts } = JSON.parse(Buffer.from(header, "base64").toString()) as { accepts: { scheme: string; amount: string }[] };
  const credit = accepts.find((a) => a.scheme === "hush-credit");
  return { amount: BigInt(credit?.amount ?? accepts[0]?.amount ?? "0"), schemes: accepts.map((a) => a.scheme) };
}

function createServer(): McpServer {
  const server = new McpServer({ name: "hush", version: "0.1.0" });

  server.registerTool(
    "hush_pay",
    {
      title: "Pay for an API privately",
      description:
        "Fetch an x402 paid HTTP endpoint and pay privately with Hush (hush-credit): an encrypted eERC top-up when credit runs low, " +
        "otherwise an off-chain signed voucher. Observers can't see the amount, the call frequency or per-call pattern. " +
        "Refuses if the endpoint asks more than maxPrice or doesn't offer hush-credit.",
      inputSchema: z.object({
        url: z.string().url().describe("The paid endpoint, e.g. http://localhost:4021/api/feed"),
        maxPrice: z.string().regex(/^\$?\d+(\.\d{1,6})?$/).optional().describe('Most you will pay for this call in USD, e.g. "0.05" (default 0.10)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ url, maxPrice }) => {
      const cap = maxPrice ? usd(maxPrice) : DEFAULT_MAX_PRICE;
      const q = await quote(url);
      if (q && !q.schemes.includes("hush-credit")) return text(`This endpoint only offers ${q.schemes.join(", ")} — not paying publicly.`, true);
      if (q && q.amount > cap) return text(`Endpoint asks ${fmtUsd(q.amount)} per call, above maxPrice ${fmtUsd(cap)}. Not paid.`, true);

      const { fetch: paidFetch } = await hush();
      const t0 = performance.now();
      const res = await paidFetch(url);
      const body = await res.text();
      const header = res.headers.get("PAYMENT-RESPONSE");
      const settle = header ? (JSON.parse(Buffer.from(header, "base64").toString()) as { success?: boolean; transaction?: string; amount?: string }) : undefined;
      return text({
        status: res.status,
        paid: settle?.success
          ? { scheme: "hush-credit", amount: settle.amount ? fmtUsd(settle.amount) : undefined, voucherCommitment: settle.transaction, privacy: "amount and call hidden; voucher will be Merkle-committed on-chain" }
          : q
            ? "payment not settled"
            : "free endpoint (no payment needed)",
        ms: Math.round(performance.now() - t0),
        body: body.length > 4000 ? `${body.slice(0, 4000)}…` : body,
      }, res.status >= 400);
    }),
  );

  server.registerTool(
    "hush_balance",
    {
      title: "Private balance and credit",
      description: "The agent's public USDC, its private eERC hUSDC balance (decrypted locally) and its prepaid hush-credit per provider.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const h = await hush();
      const [bal, usdc] = await Promise.all([
        eerc.balance(),
        publicClient.readContract({ address: contracts.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [agent.address] }),
      ]);
      const credit = await Promise.all(
        ((await h.credit?.knownProviders()) ?? []).map(async (p) => {
          const c = await h.credit!.creditState(p);
          return { provider: p, available: fmtUsd(c.available), credited: fmtUsd(c.creditedTotal), spent: fmtUsd(c.settledCumulative), refunded: fmtUsd(c.refundedTotal), expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null, frozen: c.frozen };
        }),
      );
      return text({
        agent: agent.address,
        network: NETWORK,
        publicUsdc: fmtUsd(usdc),
        privateBalance: formatHusdc(eercToAtomic(bal.decrypted, contracts.eercDecimals)),
        privateBalanceOnChain: "ElGamal ciphertext only — decrypted here with the agent's eERC key",
        credit,
      });
    }),
  );

  server.registerTool(
    "hush_history",
    {
      title: "Private payment history",
      description: "The agent's own payment history (calls, private top-ups with provider-signed receipts, refunds), newest first. Only this agent's store holds it.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional().describe("Default 20") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ limit }) => {
      const n = limit ?? 20;
      const [payments, vouchers, receipts, refunds] = await Promise.all([store.listPayments(), store.listVouchers(), store.listReceipts(), store.listRefunds()]);
      const status = new Map(vouchers.map((v) => [v.leaf.toLowerCase(), v]));
      const items = [
        ...payments.map((p) => ({
          at: p.at,
          kind: "call",
          scheme: p.scheme,
          amount: fmtUsd(p.amount),
          resource: p.resource,
          status: status.get(p.id.toLowerCase())?.status,
          committedOnChain: status.get(p.id.toLowerCase())?.verifiedOnChain ?? false,
        })),
        ...receipts.map((r) => ({ at: r.createdAt, kind: "top-up", amount: fmtUsd(r.amount), provider: r.receipt.provider, tx: txLink(r.receipt.topupTxHash), receiptSignedByProvider: true })),
        ...refunds.map((r) => ({ at: r.createdAt, kind: "refund", amount: fmtUsd(r.amount), provider: r.provider, tx: r.txHash ? txLink(r.txHash) : null })),
      ]
        .sort((a, b) => b.at - a.at)
        .slice(0, n)
        .map((i) => ({ ...i, at: new Date(i.at).toISOString() }));
      return text(items);
    }),
  );

  server.registerTool(
    "hush_verify",
    {
      title: "Verify vouchers on-chain",
      description: "Check that every settled voucher is inside a Merkle root the provider committed to HushLedger (provider accountability).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const h = await hush();
      const r = await h.credit!.verifyMyVouchers();
      return text({ verifiedOnChain: r.verified, awaitingNextBatch: r.pending, failed: r.failed.map((f) => f.leaf) });
    }),
  );

  server.registerTool(
    "hush_refund",
    {
      title: "Refund unused credit",
      description: "Ask a provider to return all unspent hush-credit via a private eERC transfer; the refund amount is decrypted and checked locally.",
      inputSchema: z.object({ provider: z.string().refine(isAddress, "must be an address") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ provider }) => {
      const h = await hush();
      const res = await h.credit!.requestRefund(getAddress(provider));
      return text({ refunded: fmtUsd(res.amount), tx: res.txHash ? txLink(res.txHash) : null, creditLeft: fmtUsd(res.credit.available) });
    }),
  );

  const ownerTool = (name: "hush_freeze" | "hush_unfreeze", freeze: boolean) =>
    server.registerTool(
      name,
      {
        title: freeze ? "Freeze an agent (kill switch)" : "Unfreeze an agent",
        description: freeze
          ? "Owner kill switch: freeze an agent in HushRegistry so every facilitator rejects its payments from the next call. Needs the OWNER key."
          : "Lift an owner freeze on an agent. Needs the OWNER key.",
        inputSchema: z.object({ agent: z.string().describe("Agent address, or a role name like VEIL") }),
        annotations: { readOnlyHint: false, destructiveHint: freeze, idempotentHint: true, openWorldHint: true },
      },
      guard(async ({ agent: who }) => {
        const owner = wallet("OWNER"); // throws a clear error if OWNER_PRIVATE_KEY isn't configured
        const target = isAddress(who) ? getAddress(who) : wallet(who.toUpperCase() as Role).address;
        const tx = await (freeze ? freezeAgent : unfreezeAgent)(owner.walletClient, publicClient, contracts.hushRegistry, target);
        return text({ agent: target, frozen: freeze, tx: txLink(tx) });
      }),
    );
  ownerTool("hush_freeze", true);
  ownerTool("hush_unfreeze", false);

  // ─── v2: trading at the Hush Desk ───────────────────────────────────────────
  const ticker = z.enum(STOCK_TICKERS).describe("Mock stock ticker");
  const shares = z.string().regex(/^\d+(\.\d{1,2})?$/, "shares with at most 2 decimals, e.g. 0.10").describe('Number of shares, e.g. "0.10" (0.01 is the smallest unit)');
  const side = z.enum(["buy", "sell"]);

  server.registerTool(
    "hush_quote",
    {
      title: "Get a desk quote",
      description: "A firm, desk-signed price for buying or selling a mock stock at the Hush Desk (valid ~15 s). Nothing is paid or signed by the agent.",
      inputSchema: z.object({ ticker, side, shares }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ ticker: t, side: s, shares: n }) => {
      const { client } = await desk();
      const { quote } = await client.quote(t, s, n);
      return text({
        ticker: t,
        side: s,
        shares: formatShares(quote.size),
        pricePerShare: `$${formatPrice(quote.price)}`,
        notional: fmtUsd(quote.notional),
        oracleMark: `$${formatPrice(await mark(t))}`,
        expiresAt: new Date(Number(quote.expiry) * 1000).toISOString(),
        signedByDesk: quote.desk,
      });
    }),
  );

  server.registerTool(
    "hush_trade",
    {
      title: "Trade privately at the Hush Desk",
      description:
        "Buy or sell a mock stock at the Hush Desk with hush-rfq. A buy is paid with an off-chain voucher against encrypted desk credit " +
        "(topped up privately in fixed chunks when low); a sell is a signed order whose proceeds go to desk credit. The desk custodies the " +
        "position and returns a signed fill + position statement. On-chain an observer sees no trade — at most an encrypted top-up. " +
        "Refuses above limitPrice (buy) / below it (sell), and when the owner's trade policy (per-trade max, position max, daily cap) would be broken.",
      inputSchema: z.object({
        ticker,
        side,
        shares,
        limitPrice: z.string().regex(/^\$?\d+(\.\d{1,6})?$/).optional().describe('Worst acceptable price per share in USD, e.g. "185.50"'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ ticker: t, side: s, shares: n, limitPrice }) => {
      const { client } = await desk();
      if (limitPrice) {
        const { quote } = await client.quote(t, s, n);
        const limit = usd(limitPrice);
        if (s === "buy" ? quote.price > limit : quote.price < limit) {
          return text(`Desk quotes $${formatPrice(quote.price)} per share, ${s === "buy" ? "above" : "below"} your limit $${formatPrice(limit)}. Not traded.`, true);
        }
      }
      const topUpsBefore = (await store.listReceipts()).length;
      const t0 = performance.now();
      const r = s === "buy" ? await client.buy(t, n) : await client.sell(t, n);
      const toppedUp = (await store.listReceipts()).length > topUpsBefore;
      return text({
        filled: { ticker: t, side: s, shares: formatShares(r.fill.size), pricePerShare: `$${formatPrice(r.fill.price)}`, notional: fmtUsd((r.fill.size * r.fill.price) / 100n) },
        position: { shares: formatShares(r.statement.position), avgCost: r.statement.position === 0n ? null : `$${formatPrice(r.statement.avgCost)}`, statementSeq: r.statement.seq.toString() },
        ...("credit" in r && { deskCreditAvailable: fmtUsd(r.credit.available) }),
        onChainFootprint: toppedUp ? "one encrypted eERC top-up to the desk (amount hidden); the trade itself is off-chain" : "none — voucher off-chain, position custodied by the desk",
        receipts: "desk-signed FillReceipt + PositionStatement verified and stored (see hush_positions / hush_prove_me)",
        ms: Math.round(performance.now() - t0),
      });
    }),
  );

  server.registerTool(
    "hush_positions",
    {
      title: "Custodied positions",
      description:
        "The agent's positions at the Hush Desk from desk-signed statements, marked at the on-chain oracle, plus desk credit and settle-out status. " +
        "Also audits the desk: every statement must be desk-signed and equal what the agent's own fills and settle-outs add up to.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const { client } = await desk();
      const [audit, credit, settleOuts] = await Promise.all([client.verifyPositions(), client.creditState().catch(() => null), client.settleOuts().catch(() => [])]);
      const positions = await Promise.all(
        audit.positions
          .filter((p) => p.position > 0n)
          .map(async (p) => {
            const m = await mark(p.ticker);
            return {
              ticker: p.ticker,
              shares: formatShares(p.position),
              avgCost: `$${formatPrice(p.avgCost)}`,
              mark: `$${formatPrice(m)}`,
              unrealizedPnl: fmtSigned(((m - p.avgCost) * p.position) / 100n),
              statementSeq: p.seq.toString(),
            };
          }),
      );
      return text({
        positions,
        deskCredit: credit ? { available: fmtUsd(credit.available), proceeds: credit.proceedsTotal ? fmtUsd(credit.proceedsTotal) : undefined } : null,
        // SettleOutJson.size is already in shares ("0.01").
        settleOuts: settleOuts.slice(-5).map((s) => ({ ticker: s.ticker, shares: s.size, status: s.status, tx: s.txHash ? txLink(s.txHash) : null })),
        deskAudit: audit.ok ? "ok — statements match my fills and settle-outs" : audit.issues,
        privacy: "positions live only in desk-signed statements held by the agent (and its owner); nothing on-chain names them",
      });
    }),
  );

  server.registerTool(
    "hush_settle",
    {
      title: "Withdraw custodied shares",
      description:
        "Have custodied shares delivered to the agent's own address as one private eERC transfer (encrypted hStock), sent with other " +
        "settle-outs on the desk's next batch tick. The transfer reveals the asset and both addresses, not the size.",
      inputSchema: z.object({ ticker, shares }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ ticker: t, shares: n }) => {
      const { client } = await desk();
      const r = await client.settleOut(t, n);
      return text({
        queued: { ticker: t, shares: n, requestId: r.settleOut.requestId, status: r.settleOut.status },
        positionLeft: formatShares(r.statement.position),
        next: "sent at the desk's next batch tick; check hush_positions for the transaction",
      });
    }),
  );

  // ─── v2: Proof of Alpha ─────────────────────────────────────────────────────
  server.registerTool(
    "hush_verify_provider",
    {
      title: "Verify a signal provider's track record",
      description:
        "Before paying for signals: fetch the provider's Proof of Alpha and verify it yourself against the chain heads it committed to " +
        "HushAlpha and the stock oracle. Claims on its page are ignored; a provider that hid losing calls fails at the first doctored epoch.",
      inputSchema: z.object({ url: z.string().url().describe("Provider base URL, e.g. http://localhost:4021 (SignalCo) or http://localhost:4025 (AlphaKing)") }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ url }) => {
      if (!contracts.stockOracle) throw new Error(`the ${NETWORK} deployment has no stock oracle`);
      const c = await checkProvider(url, {
        publicClient: publicClient as never,
        oracle: contracts.stockOracle,
        hushAlpha: contracts.hushAlpha, // trust only our HushAlpha deployment, whatever the proof names
        chainId: contracts.chainId,
        policy: ALPHA_POLICY,
      });
      const pct = (x: number | null | undefined) => (x === null || x === undefined ? null : `${Math.round(x * 100)}%`);
      const r = c.report;
      return text({
        provider: c.name,
        claimed: c.claims ? { winRate: pct(c.claims.winRate), calls: c.claims.calls } : null,
        verified: r
          ? {
              proofValid: r.valid,
              ...(r.valid ? {} : { failedAtEpoch: r.failedEpoch, reason: r.reason }),
              winRate: r.valid ? pct(r.winRate) : null,
              resolvedCalls: r.calls,
              cumulativeReturn: `${(r.pnlBps / 100).toFixed(2)}%`,
              maxDrawdown: `${(r.maxDrawdownBps / 100).toFixed(2)}%`,
              epochs: `${r.committedEpochs}/${r.epochs} committed on-chain`,
              pending: r.pending,
            }
          : null,
        policy: ALPHA_POLICY,
        passes: c.passes,
        verdict: c.why,
      });
    }),
  );

  server.registerTool(
    "hush_prove_me",
    {
      title: "Prove my trading record",
      description:
        "Build the agent's own trade report at the Hush Desk — every desk-signed fill and position statement, each fill tied to the voucher " +
        "that paid for it and that voucher's Merkle proof in a HushLedger root — verify it, and save it to a file the agent can hand to " +
        "whoever it chooses. Statements are numbered by the desk, so an omitted (losing) trade shows. Nothing is published.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const { address: deskAddress } = await desk();
      const proofs = new HushFacilitatorApi(URLS.desk);
      const report = await buildTradeReport({
        store,
        agent: agent.address,
        desk: deskAddress,
        chainId: contracts.chainId,
        hushAlpha: contracts.hushAlpha!,
        hushLedger: contracts.hushLedger,
        proof: (leaf) => proofs.proof(leaf),
      });
      const r = await verifyTradeReport(report, {
        publicClient: publicClient as never,
        oracle: contracts.stockOracle,
        expect: { desk: deskAddress, hushLedger: contracts.hushLedger, hushAlpha: contracts.hushAlpha, chainId: contracts.chainId },
      });
      mkdirSync(DATA_DIR, { recursive: true });
      const file = path.join(DATA_DIR, `trade-report-${ROLE.toLowerCase()}-${NETWORK}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2));
      return text({
        valid: r.valid,
        ...(r.reason && { reason: r.reason }),
        complete: r.complete,
        ...(r.incompleteBecause && { incompleteBecause: r.incompleteBecause }),
        trades: { fills: r.fills, buys: r.buys, sells: r.sells, settleOuts: r.settleOuts, lastStatementSeq: r.lastSeq },
        onChainAnchors: `${r.committedOnChain}/${r.fills} fills' vouchers verified inside HushLedger batch roots (the rest await the next batch)`,
        bought: fmtUsd(r.boughtNotional),
        sold: fmtUsd(r.soldNotional),
        realizedPnl: fmtSigned(r.realizedPnl),
        unrealizedPnl: r.unrealizedPnl === null ? null : fmtSigned(r.unrealizedPnl),
        tickers: r.tickers.map((x) => ({ ticker: x.ticker, shares: formatShares(BigInt(x.position)), realizedPnl: fmtSigned(x.realizedPnl), unrealizedPnl: x.unrealizedPnl === null ? null : fmtSigned(x.unrealizedPnl) })),
        reportFile: file,
        howToVerify: "verifyTradeReport(report, { publicClient, oracle, expect: { desk, hushLedger, hushAlpha, chainId } }) from @hush/x402/contracts — viem only, runs in a browser; the verifier pins the desk and contracts it trusts",
        trust: "tamper-evident against everyone but the desk (the counterparty signs every record)",
      });
    }),
  );

  return server;
}

void serveStdio(createServer);
console.error(`hush MCP server on stdio · agent ${ROLE} ${agent.address} · ${NETWORK}`);
