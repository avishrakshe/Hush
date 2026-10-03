/**
 * Hush Desk — a market maker that is just another x402 provider (v2, `hush-rfq`). The 402 *is* the quote.
 *
 *   GET  /rfq?ticker=NVDA&side=buy&size=0.10&agent=0x…   402 with a desk-signed quote (15 s), payable two ways:
 *          hush-rfq  a hush-credit voucher against the agent's prepaid hUSDC at the desk → custodied position;
 *                    signed fill + position statement come back in PAYMENT-RESPONSE. Nothing on-chain per trade.
 *          exact     public USDC (EIP-3009) → plain mStock delivered publicly — the baseline anyone (Mirror) can read.
 *   GET  /quote?ticker=NVDA&side=sell&size=0.05&agent=0x…  signed sell quote (200)
 *   POST /sell            { quote, quoteSignature, payment }  zero-increment voucher = the order; proceeds → desk credit
 *   GET  /positions/:agent    signed custody statements (x-hush-credit-auth from the agent or its owner)
 *   POST /settle-out      { request, signature }  queued; one private eERC transfer on the next batch tick
 *   GET  /settle-outs/:agent  (signed)   ·   GET /inventory   ·   GET /fills (admin)
 *   + the desk's own facilitator on the same port: /topup /credit /refund /proof /batches /events /admin/*
 *
 *   pnpm desk   (Fuji)   ·   pnpm desk:local
 */
import { NETWORK, PORTS, URLS, publicClient, txLink } from "@hush/config";
import { createFacilitator, log } from "@hush/facilitator/app";
import { SqliteDeskStore } from "@hush/facilitator/desk-store";
import { CREDIT_AUTH_HEADER, EXACT, HUSH_RFQ, STOCK_TICKERS, type Side, formatShares, parseShares, quoteToJson, tickerToBytes32 } from "@hush/x402";
import { type DeskEvent, HushDeskService, HushError, HushRfqFacilitatorScheme, quoteExtra } from "@hush/x402/facilitator";
import { HushRfqServerScheme, echoedPayment } from "@hush/x402/server";
import { type FacilitatorClient, type HTTPRequestContext, x402ResourceServer } from "@x402/core/server";
import type { Price, SupportedResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/express";
import type { Request } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, getAddress, isAddress } from "viem";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_URL = URLS.desk;
// The `exact` path pays MockUSDC by EIP-3009; its EIP-712 domain (name/version) must ride in the requirements.
const USDC_DOMAIN = { name: process.env.USDC_EIP712_NAME || "Hush Test USDC", version: process.env.USDC_EIP712_VERSION || "1" };

const f = await createFacilitator({
  role: "DESK",
  committerRole: "DESK", // the desk commits its own batches (HushLedger accepts the provider itself)
  name: "desk",
  dbFile: process.env.DESK_DB || path.join(APP_DIR, ".data", `desk-${NETWORK}.db`),
  adminToken: process.env.DESK_ADMIN_TOKEN,
});
const { contracts, network } = f;
if (!contracts.hushAlpha || !contracts.stockOracle) {
  throw new Error("this deployment has no HushAlpha / mock stocks — run `pnpm deploy:local` (or deploy:alpha:fuji + deploy:stocks:fuji) and export");
}

/** Admin stream: everything. Public stream: only what the chain already shows (exact fills, settle-out transfers). */
function onDeskEvent(e: DeskEvent) {
  f.adminEvents.publish(`desk:${e.type}`, { ...e });
  if (e.type === "fill" && e.scheme === EXACT) {
    f.publicEvents.publish("desk:public-fill", { agent: e.agent, ticker: e.ticker, side: e.side, size: e.size, price: e.price, paymentTx: e.paymentTx, deliveryTx: e.deliveryTx });
  }
  if (e.type === "settle-out:sent") f.publicEvents.publish("desk:settle-out", { agent: e.agent, ticker: e.ticker, txHash: e.txHash });
  // hush-rfq quotes and fills stay private: even their timing would reveal the agent's trading.
}

const desk = new HushDeskService({
  service: f.service,
  signer: f.provider.account,
  contracts,
  publicClient: publicClient as never,
  store: new SqliteDeskStore(f.db),
  deskEerc: f.providerEerc,
  deskWallet: f.provider.walletClient,
  spreadBps: Number(process.env.DESK_SPREAD_BPS || 10),
  maxOracleAgeSeconds: Number(process.env.DESK_MAX_ORACLE_AGE_SECONDS || 600),
  onEvent: onDeskEvent,
});
f.x402.register(network, new HushRfqFacilitatorScheme(desk));

// ─── x402 resource server, settling through the in-process facilitator ───
const local: FacilitatorClient = {
  verify: (payload, requirements) => f.x402.verify(payload, requirements),
  settle: (payload, requirements) => f.x402.settle(payload, requirements),
  // The facilitator types `network` as a plain string; the client interface wants the CAIP-2 template type.
  getSupported: async () => f.x402.getSupported() as SupportedResponse,
};
const server = new x402ResourceServer(local);
server.register(network, new ExactEvmScheme());
server.register(network, new HushRfqServerScheme({ contracts, facilitatorUrl: PUBLIC_URL, minTopUp: 1_000_000n }));

// Public path: consume the quote before the USDC moves (a quote fills at most once), deliver tokens after it did.
const reserved = new Map<string, Awaited<ReturnType<typeof desk.reservePublicFill>>>();
server.onBeforeSettle(async ({ paymentPayload, requirements }) => {
  if (requirements.scheme !== EXACT) return;
  const extra = requirements.extra as { quote?: never; quoteSignature?: Hex };
  const payer = (paymentPayload.payload as { authorization?: { from?: string } }).authorization?.from;
  if (!extra.quote || !extra.quoteSignature || !payer) return { abort: true, reason: "missing quote or payer" };
  try {
    const quote = await desk.reservePublicFill({ quote: extra.quote, signature: extra.quoteSignature }, getAddress(payer));
    reserved.set(quote.quoteId, quote);
  } catch (err) {
    return { abort: true, reason: (err as Error).message };
  }
});
server.onAfterSettle(async ({ requirements, result }) => {
  if (requirements.scheme !== EXACT || !result.success) return;
  const quoteId = (requirements.extra as { quote?: { quoteId?: string } }).quote?.quoteId;
  const quote = quoteId ? reserved.get(quoteId) : undefined;
  if (!quote) return;
  reserved.delete(quote.quoteId);
  const { deliveryTx } = await desk.deliverPublicFill(quote, result.transaction as Hex);
  log(`public fill: ${formatShares(quote.size)} → ${quote.agent} paid ${txLink(result.transaction)} · delivered ${txLink(deliveryTx)}`);
});

// ─── /rfq: the 402 is the quote ───
interface RfqParams {
  ticker: string;
  side: Side;
  size: bigint;
  agent: Address;
}
function rfqParams(query: Record<string, unknown>): RfqParams {
  const ticker = String(query.ticker ?? "").toUpperCase();
  const side = String(query.side ?? "buy").toLowerCase();
  const agent = String(query.agent ?? "");
  if (!(STOCK_TICKERS as readonly string[]).includes(ticker)) throw new HushError("unknown_ticker", `ticker must be one of ${STOCK_TICKERS.join(", ")}`);
  if (side !== "buy") throw new HushError("invalid_side", "the /rfq paywall is for buys — sells go through GET /quote + POST /sell");
  if (!isAddress(agent)) throw new HushError("invalid_address", "agent=0x… (the address that will pay) is required");
  let size: bigint;
  try {
    size = parseShares(String(query.size ?? ""));
  } catch (err) {
    throw new HushError("invalid_size", (err as Error).message);
  }
  return { ticker, side, size, agent: getAddress(agent) };
}

/**
 * One fresh quote per request, shared by both offered schemes (x402 builds each scheme's requirements from the same
 * request context). On the paid retry, the quote the client echoes back is re-checked and re-offered unchanged, so the
 * accepted requirements match; an expired, used or foreign quote just gets a fresh one (a new 402).
 */
const freshQuotes = new WeakMap<object, Promise<Awaited<ReturnType<typeof desk.quote>>>>();
function rfqPrice(scheme: typeof EXACT | typeof HUSH_RFQ) {
  return async (ctx: HTTPRequestContext): Promise<Price> => {
    const p = rfqParams((ctx.adapter.getQueryParams?.() ?? {}) as Record<string, unknown>);
    const echoed = echoedPayment(ctx);
    const echoedExtra = echoed?.accepted?.extra as { quote?: never; quoteSignature?: Hex } | undefined;
    let signed: Awaited<ReturnType<typeof desk.quote>> | undefined;
    if (echoed?.accepted?.scheme === scheme && echoedExtra?.quote && echoedExtra.quoteSignature) {
      try {
        const quote = await desk.checkQuote({ quote: echoedExtra.quote, signature: echoedExtra.quoteSignature }, { agent: p.agent, side: "buy" });
        if (quote.size === p.size && quote.ticker.toLowerCase() === tickerToBytes32(p.ticker).toLowerCase()) {
          signed = { quote, signature: echoedExtra.quoteSignature };
        }
      } catch {
        // stale or foreign quote → offer a fresh one below
      }
    }
    if (!signed) {
      let pending = freshQuotes.get(ctx);
      if (!pending) {
        pending = desk.quote(p);
        freshQuotes.set(ctx, pending);
      }
      signed = await pending;
    }
    const extra = scheme === EXACT ? { ...USDC_DOMAIN, ...quoteExtra(signed) } : quoteExtra(signed);
    return { amount: signed.quote.notional.toString(), asset: contracts.usdc, extra };
  };
}

const { app, send, wrap, addressParam, requireAdmin } = f;

// Validate before the paywall: nobody gets a 402 (or pays) for a malformed request.
app.use("/rfq", (req, _res, next) => {
  try {
    rfqParams(req.query as Record<string, unknown>);
    next();
  } catch (err) {
    next(err);
  }
});
app.use(
  paymentMiddleware(
    {
      "GET /rfq": {
        accepts: [
          { scheme: HUSH_RFQ, network, payTo: desk.desk, price: rfqPrice(HUSH_RFQ), maxTimeoutSeconds: 60 },
          { scheme: EXACT, network, payTo: desk.desk, price: rfqPrice(EXACT), maxTimeoutSeconds: 60 },
        ],
        description: "Hush Desk quote: mock-stock buy at oracle ± spread (Fuji mocks — no issuer affiliation)",
        mimeType: "application/json",
      },
    },
    server,
  ),
);
// Reached only once the payment verified; the fill itself is booked at settlement (receipts in PAYMENT-RESPONSE).
app.get("/rfq", (req: Request, res) => {
  const p = rfqParams(req.query as Record<string, unknown>);
  send(res, { status: "accepted", ticker: p.ticker, size: formatShares(p.size), receipts: "see the PAYMENT-RESPONSE header" });
});

// ─── sells, custody, settle-outs ───
app.get(
  "/quote",
  wrap(async (req, res) => {
    const q = req.query as Record<string, string>;
    const side = (q.side ?? "sell").toLowerCase() as Side;
    if (side !== "sell" && side !== "buy") throw new HushError("invalid_side", "side must be buy or sell");
    let size: bigint;
    try {
      size = parseShares(q.size ?? "");
    } catch (err) {
      throw new HushError("invalid_size", (err as Error).message);
    }
    const signed = await desk.quote({ agent: addressParam(q.agent), ticker: q.ticker ?? "", side, size });
    send(res, { quote: quoteToJson(signed.quote), signature: signed.signature });
  }),
);
app.post(
  "/sell",
  wrap(async (req, res) => {
    const { quote, quoteSignature, payment } = req.body as { quote?: never; quoteSignature?: Hex; payment?: never };
    if (!quote || !quoteSignature || !payment) throw new HushError("invalid_request", "expected { quote, quoteSignature, payment }");
    send(res, await desk.sell({ quote, signature: quoteSignature }, payment));
  }),
);
app.get(
  "/positions/:agent",
  wrap(async (req, res) => send(res, await desk.positions(await f.service.assertAgentOrOwner(addressParam(req.params.agent), req.get(CREDIT_AUTH_HEADER))))),
);
app.post(
  "/settle-out",
  wrap(async (req, res) => {
    const { request, signature } = req.body as { request?: never; signature?: Hex };
    if (!request || !signature) throw new HushError("invalid_request", "expected { request, signature }");
    send(res, await desk.requestSettleOut(request, signature));
  }),
);
app.get(
  "/settle-outs/:agent",
  wrap(async (req, res) => send(res, await desk.settleOuts(await f.service.assertAgentOrOwner(addressParam(req.params.agent), req.get(CREDIT_AUTH_HEADER))))),
);
// Desk inventory is public anyway (its deposits and plain balances are on-chain); custody totals are aggregates.
app.get("/inventory", wrap(async (_req, res) => send(res, await desk.inventory())));
app.get("/fills", requireAdmin, wrap(async (_req, res) => send(res, await desk.store.listFills({ limit: 200 }))));
app.post("/admin/settle-outs", requireAdmin, wrap(async (_req, res) => send(res, await desk.processSettleOuts())));
app.get("/", (_req, res) =>
  send(res, {
    name: "Hush Desk",
    desk: desk.desk,
    network: NETWORK,
    schemes: [HUSH_RFQ, EXACT],
    tickers: STOCK_TICKERS,
    rfq: `${PUBLIC_URL}/rfq?ticker=NVDA&side=buy&size=0.10&agent=0x…`,
    note: "Mock stocks on Fuji; no issuer (Dinari, Pharaoh, …) integration. Positions are custodied by the desk.",
  }),
);

// Settle-outs run right after each batch commit: same fixed cadence, and several agents' transfers go out together.
f.startJobs(async () => {
  for (const s of await desk.processSettleOuts()) {
    log(`settle-out ${s.status}: ${s.size} ${s.ticker} → ${s.agent} ${s.txHash ? txLink(s.txHash) : s.error ?? ""}`);
  }
});
f.listen(PORTS.desk, [`desk        ${desk.desk}  spread ${process.env.DESK_SPREAD_BPS || 10} bps · quotes live 15 s`, `oracle      ${contracts.stockOracle}`]);
