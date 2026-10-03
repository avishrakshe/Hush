import type { PaymentResponseContext } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayloadResult, PaymentRequirements, SchemeClientHooks, SchemeNetworkClient } from "@x402/core/types";
import { type Address, type Hex, type TypedDataDomain, getAddress, isAddressEqual, toHex } from "viem";
import {
  alphaDomain,
  fillFromJson,
  fillTyped,
  formatShares,
  parseShares,
  quoteFromJson,
  quoteNotional,
  quoteRequestHash,
  quoteToJson,
  quoteTyped,
  settleOutToJson,
  settleOutTyped,
  statementFromJson,
  statementTyped,
} from "../alpha.js";
import { CREDIT_AUTH_HEADER, HUSH_RFQ, SIDE, type Side, type StockTicker } from "../constants.js";
import { type TypedDataSigner, creditAuthHeader, hushDomain } from "../eip712.js";
import { bytes32ToTicker, isStockTicker, tickerToBytes32 } from "../stocks.js";
import type {
  CreditStateJson,
  FillReceipt,
  HushRfqExtra,
  PositionStatement,
  Quote,
  RfqSettleExtra,
  SettleOutJson,
  SignedFillJson,
  SignedQuoteJson,
  SignedStatementJson,
} from "../types.js";
import { type HushClientEvent, type HushCreditClient, type ProviderConfig, parseCreditExtra } from "./hushCredit.js";
import type { HushFetch } from "./hushFetch.js";
import type { HushStore } from "./store.js";

const chainIdOf = (network: string) => Number(network.split(":")[1]);

// ─────────────────────────────── trade policy ───────────────────────────────

/** Owner-set guard rails for trading, enforced before the agent signs anything. Separate from SpendPolicy (API spend). */
export interface TradePolicy {
  allowedDesks?: Address[];
  allowedTickers?: StockTicker[];
  /** Max notional per trade (USDC atomic). */
  maxNotionalPerTrade?: bigint;
  /** Max custodied position per ticker after a buy (0.01-share units). */
  maxPosition?: bigint;
  /** Max total buy notional per UTC day (USDC atomic). */
  dailyNotionalCap?: bigint;
}

export class TradePolicyViolation extends Error {
  constructor(
    readonly reason: "desk_not_allowed" | "ticker_not_allowed" | "over_per_trade_max" | "over_position_max" | "over_daily_cap",
    message: string,
  ) {
    super(message);
    this.name = "TradePolicyViolation";
  }
}

const startOfUtcDay = (now = Date.now()) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export async function boughtToday(store: HushStore, now = Date.now()): Promise<bigint> {
  const since = startOfUtcDay(now);
  return (await store.listFills())
    .filter((f) => f.createdAt >= since && Number(f.fill.side) === SIDE.buy)
    .reduce((sum, f) => sum + BigInt(f.notional), 0n);
}

/** Latest custodied position the agent was told about for (desk, ticker), by statement seq. */
export async function knownPosition(store: HushStore, desk: Address, ticker: StockTicker): Promise<{ position: bigint; seq: bigint }> {
  const t = tickerToBytes32(ticker).toLowerCase();
  let best = { position: 0n, seq: 0n };
  for (const s of await store.listStatements()) {
    if (!isAddressEqual(s.desk, desk) || s.statement.ticker.toLowerCase() !== t) continue;
    const seq = BigInt(s.statement.seq);
    if (seq > best.seq) best = { position: BigInt(s.statement.position), seq };
  }
  return best;
}

export async function assertTradePolicy(policy: TradePolicy | undefined, store: HushStore, desk: Address, quote: Quote) {
  if (!policy) return;
  const ticker = bytes32ToTicker(quote.ticker);
  if (policy.allowedDesks && !policy.allowedDesks.some((d) => isAddressEqual(d, desk))) {
    throw new TradePolicyViolation("desk_not_allowed", `desk ${desk} is not on the allowlist`);
  }
  if (policy.allowedTickers && !policy.allowedTickers.includes(ticker as StockTicker)) {
    throw new TradePolicyViolation("ticker_not_allowed", `${ticker} is not an allowed ticker`);
  }
  if (quote.side !== SIDE.buy) return; // sells only reduce exposure
  if (policy.maxNotionalPerTrade !== undefined && quote.notional > policy.maxNotionalPerTrade) {
    throw new TradePolicyViolation("over_per_trade_max", `notional ${quote.notional} exceeds per-trade max ${policy.maxNotionalPerTrade}`);
  }
  if (policy.maxPosition !== undefined) {
    const { position } = await knownPosition(store, desk, ticker as StockTicker);
    if (position + quote.size > policy.maxPosition) {
      throw new TradePolicyViolation("over_position_max", `${ticker} position would be ${formatShares(position + quote.size)} (max ${formatShares(policy.maxPosition)})`);
    }
  }
  if (policy.dailyNotionalCap !== undefined) {
    const today = await boughtToday(store);
    if (today + quote.notional > policy.dailyNotionalCap) {
      throw new TradePolicyViolation("over_daily_cap", `daily trading cap ${policy.dailyNotionalCap} reached (bought ${today} today)`);
    }
  }
}

export function parseRfqExtra(extra: Record<string, unknown> | undefined): HushRfqExtra {
  const credit = parseCreditExtra(extra);
  const e = (extra ?? {}) as Partial<HushRfqExtra>;
  if (!e.hushAlpha || !e.quote || !e.quoteSignature) throw new Error("hush-rfq requirements missing extra.hushAlpha / quote / quoteSignature");
  return { ...credit, hushAlpha: e.hushAlpha, quote: e.quote, quoteSignature: e.quoteSignature };
}

// ─────────────────────────────── receipts ───────────────────────────────

/**
 * Checks what the desk returned for a fill: both records desk-signed, about this agent and exactly this quote, and the
 * statement continues the agent's statement sequence. Returns the parsed records; throws on anything off.
 */
export async function verifyFillReceipts(args: {
  domain: TypedDataDomain;
  desk: Address;
  agent: Address;
  quote: Quote;
  fill: SignedFillJson;
  statement: SignedStatementJson;
  store?: HushStore;
}): Promise<{ fill: FillReceipt; statement: PositionStatement }> {
  const fill = fillFromJson(args.fill.fill);
  const statement = statementFromJson(args.statement.statement);
  const q = args.quote;
  if (!isAddressEqual(fill.desk, args.desk) || !(await fillTyped.isValid(args.domain, fill, args.fill.signature))) {
    throw new Error("fill receipt not signed by the desk");
  }
  if (
    fill.quoteId !== q.quoteId ||
    !isAddressEqual(fill.agent, args.agent) ||
    fill.ticker.toLowerCase() !== q.ticker.toLowerCase() ||
    fill.side !== q.side ||
    fill.size !== q.size ||
    fill.price !== q.price
  ) {
    throw new Error("fill receipt does not match the quote");
  }
  if (!isAddressEqual(statement.desk, args.desk) || !(await statementTyped.isValid(args.domain, statement, args.statement.signature))) {
    throw new Error("position statement not signed by the desk");
  }
  if (!isAddressEqual(statement.agent, args.agent) || statement.ticker.toLowerCase() !== q.ticker.toLowerCase()) {
    throw new Error("position statement is for another agent or ticker");
  }
  if (args.store) {
    const ticker = bytes32ToTicker(q.ticker) as StockTicker;
    const prev = await knownPosition(args.store, args.desk, ticker);
    const lastSeq = (await args.store.listStatements())
      .filter((s) => isAddressEqual(s.desk, args.desk))
      .reduce((m, s) => (BigInt(s.statement.seq) > m ? BigInt(s.statement.seq) : m), 0n);
    if (statement.seq <= lastSeq) throw new Error(`statement seq ${statement.seq} does not advance (last ${lastSeq})`);
    // With no statements missed in between, the arithmetic must hold exactly.
    if (statement.seq === lastSeq + 1n) {
      const expected = prev.position + (q.side === SIDE.buy ? q.size : -q.size);
      if (statement.position !== expected) throw new Error(`statement says ${statement.position}, expected ${expected} centishares`);
    }
  }
  return { fill, statement };
}

// ─────────────────────────────── x402 scheme client ───────────────────────────────

export interface HushRfqClientOptions {
  /** The agent's EOA (signs vouchers). */
  signer: TypedDataSigner;
  /** The agent's hush-credit client: one voucher stream + lock per desk, shared with hush-credit. */
  credit: HushCreditClient;
  store: HushStore;
  policy?: TradePolicy;
  onEvent?: (e: HushClientEvent) => void;
}

/**
 * x402 v2 client mechanism for `hush-rfq`: checks the desk's signed quote in the 402, applies TradePolicy, and pays the
 * notional with a hush-credit voucher whose requestHash is the quote digest (no on-chain transaction). The desk's
 * signed fill + position statement come back in PAYMENT-RESPONSE and are verified and stored.
 * Credit must already cover the notional — HushDeskClient.buy tops up first (a top-up outlives a 15 s quote).
 */
export class HushRfqClient implements SchemeNetworkClient {
  readonly scheme = HUSH_RFQ;
  readonly schemeHooks: SchemeClientHooks;
  readonly agent: Address;

  constructor(private readonly opts: HushRfqClientOptions) {
    this.agent = getAddress(opts.signer.address);
    this.schemeHooks = { onPaymentResponse: async (ctx: PaymentResponseContext) => this.onPaymentResponse(ctx) };
  }

  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    const extra = parseRfqExtra(req.extra);
    const desk = getAddress(req.payTo);
    const chainId = chainIdOf(req.network);
    const domain = alphaDomain(chainId, extra.hushAlpha);
    const quote = quoteFromJson(extra.quote);

    if (!isAddressEqual(quote.desk, desk) || !(await quoteTyped.isValid(domain, quote, extra.quoteSignature))) {
      throw new Error("hush-rfq: quote not signed by the desk being paid");
    }
    if (!isAddressEqual(quote.agent, this.agent)) throw new Error("hush-rfq: quote was issued to another agent");
    if (quote.side !== SIDE.buy) throw new Error("hush-rfq: only buys are paid through x402 (sells are signed orders)");
    if (quote.notional !== quoteNotional(quote.size, quote.price) || BigInt(req.amount) !== quote.notional) {
      throw new Error("hush-rfq: amount does not match the quote");
    }
    if (Number(quote.expiry) <= Math.floor(Date.now() / 1000)) throw new Error("hush-rfq: quote already expired");
    await assertTradePolicy(this.opts.policy, this.opts.store, desk, quote);

    const payload = await this.opts.credit.createVoucherPayment(
      desk,
      { extra: parseCreditExtra(req.extra), chainId },
      quote.notional,
      quoteRequestHash(domain, quote),
      `${HUSH_RFQ}:${quote.quoteId}`,
      { allowTopUp: false, recordPayment: false },
    );
    return { x402Version, payload: payload as unknown as Record<string, unknown> };
  }

  private async onPaymentResponse(ctx: PaymentResponseContext) {
    await this.opts.credit.onPaymentResponse(ctx);
    let extra: HushRfqExtra;
    try {
      extra = parseRfqExtra(ctx.requirements.extra);
    } catch {
      return;
    }
    const desk = getAddress(ctx.requirements.payTo);
    const quote = quoteFromJson(extra.quote);
    const settled = ctx.settleResponse;
    if (!settled?.success) {
      this.emit({ type: "trade:rejected", desk, quoteId: quote.quoteId, reason: settled?.errorReason ?? ctx.error?.message ?? "payment rejected" });
      return;
    }
    try {
      const receipts = settled.extra as unknown as RfqSettleExtra;
      const domain = alphaDomain(chainIdOf(ctx.requirements.network), extra.hushAlpha);
      const { statement } = await verifyFillReceipts({ domain, desk, agent: this.agent, quote, ...receipts, store: this.opts.store });
      await recordFill(this.opts.store, desk, quote, receipts.fill, receipts.statement, receipts.voucherLeaf);
      this.emit({ type: "trade:filled", desk, quoteId: quote.quoteId, ticker: bytes32ToTicker(quote.ticker), side: "buy", size: quote.size, price: quote.price, notional: quote.notional, position: statement.position });
    } catch (err) {
      this.emit({ type: "error", error: err as Error });
    }
  }

  private emit(e: HushClientEvent) {
    try {
      this.opts.onEvent?.(e);
    } catch {
      // listeners must never break trading
    }
  }
}

async function recordFill(store: HushStore, desk: Address, quote: Quote, fill: SignedFillJson, statement: SignedStatementJson, voucherLeaf: Hex | null) {
  const now = Date.now();
  await store.addFill({ desk, fill: fill.fill, signature: fill.signature, notional: quote.notional.toString(), voucherLeaf, createdAt: now });
  await store.addStatement({ desk, statement: statement.statement, signature: statement.signature, createdAt: now });
}

// ─────────────────────────────── high-level desk client ───────────────────────────────

export interface HushDeskClientOptions {
  /** Desk base URL, e.g. http://localhost:4023 (it also serves the desk's facilitator endpoints). */
  deskUrl: string;
  /** createHushFetch({ mode: "hush-credit", eercClient, ... }) — provides the credit and hush-rfq clients. */
  hush: HushFetch;
  signer: TypedDataSigner;
  fetch?: typeof fetch;
}

export interface DeskPosition {
  ticker: StockTicker;
  /** 0.01-share units. */
  position: bigint;
  /** USDC atomic per share. */
  avgCost: bigint;
  seq: bigint;
}

/**
 * The agent's trading API against a Hush Desk:
 *   buy(ticker, shares)   — x402 hush-rfq (tops up desk credit privately first if needed)
 *   sell(ticker, shares)  — signed sell order; proceeds credited to desk credit
 *   positions()           — desk-signed custody statements
 *   settleOut(...)        — have custodied shares delivered as a private eERC transfer
 *   verifyPositions()     — check the desk's statements against the agent's own fills and settle-outs
 */
export class HushDeskClient {
  readonly agent: Address;
  private terms?: { desk: Address; cfg: ProviderConfig; domain: TypedDataDomain };
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: HushDeskClientOptions) {
    if (!opts.hush.credit || !opts.hush.rfq) throw new Error("HushDeskClient needs createHushFetch with an eercClient (hush-credit + hush-rfq)");
    this.agent = getAddress(opts.signer.address);
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  private get credit() {
    return this.opts.hush.credit!;
  }
  private get store() {
    return this.opts.hush.store;
  }
  private url(path: string) {
    return new URL(path, this.opts.deskUrl.endsWith("/") ? this.opts.deskUrl : `${this.opts.deskUrl}/`).toString();
  }
  private rfqUrl(ticker: string, side: Side, shares: string | number) {
    const q = new URLSearchParams({ ticker, side, size: formatShares(parseShares(shares)), agent: this.agent });
    return this.url(`rfq?${q}`);
  }

  private async json<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
    if (!res.ok) throw new Error(`desk ${res.status}: ${body.error ?? res.statusText}${body.code ? ` (${body.code})` : ""}`);
    return body;
  }

  /** The hush-rfq requirement from an unpaid /rfq call: desk terms + a quote (price discovery only). */
  private async probe(ticker: string, shares: string | number): Promise<{ req: PaymentRequirements; extra: HushRfqExtra }> {
    const res = await this.fetchFn(this.rfqUrl(ticker, "buy", shares));
    if (res.status !== 402) await this.json(res);
    const header = res.headers.get("PAYMENT-REQUIRED");
    if (!header) throw new Error("desk did not answer with a 402 quote");
    const req = decodePaymentRequiredHeader(header).accepts.find((a) => a.scheme === HUSH_RFQ);
    if (!req) throw new Error("desk does not offer hush-rfq");
    const extra = parseRfqExtra(req.extra);
    const chainId = chainIdOf(req.network);
    const desk = getAddress(req.payTo);
    this.terms = { desk, cfg: { extra: parseCreditExtra(req.extra), chainId }, domain: alphaDomain(chainId, extra.hushAlpha) };
    this.credit.registerTerms(desk, this.terms.cfg);
    return { req, extra };
  }

  private async ensureTerms() {
    if (!this.terms) await this.probe("NVDA", "0.01");
    return this.terms!;
  }

  /** A desk-signed quote (buy: from the 402; sell: from GET /quote). Verified before it is returned. */
  async quote(ticker: string, side: Side, shares: string | number): Promise<{ quote: Quote; signature: Hex }> {
    if (side === "buy") {
      const { extra } = await this.probe(ticker, shares);
      const quote = quoteFromJson(extra.quote);
      if (!(await quoteTyped.isValid(this.terms!.domain, quote, extra.quoteSignature))) throw new Error("quote not signed by the desk");
      return { quote, signature: extra.quoteSignature };
    }
    const { domain } = await this.ensureTerms();
    const q = new URLSearchParams({ ticker, side, size: formatShares(parseShares(shares)), agent: this.agent });
    const signed = await this.json<SignedQuoteJson>(await this.fetchFn(this.url(`quote?${q}`)));
    const quote = quoteFromJson(signed.quote);
    if (!(await quoteTyped.isValid(domain, quote, signed.signature)) || !isAddressEqual(quote.agent, this.agent)) {
      throw new Error("sell quote not signed by the desk for this agent");
    }
    return { quote, signature: signed.signature };
  }

  /** Desk credit available (USDC atomic) — signed read, only the agent or its owner can see it. */
  async creditState(): Promise<CreditStateJson> {
    const { desk } = await this.ensureTerms();
    return this.credit.creditState(desk);
  }

  /** Tops up desk credit privately (fixed-size chunks, see PrivacyOptions) so it covers `needed`. */
  async ensureCredit(needed: bigint): Promise<CreditStateJson> {
    const { desk } = await this.ensureTerms();
    const state = await this.credit.creditState(desk);
    if (BigInt(state.available) >= needed) return state;
    return this.credit.prefund(desk, needed - BigInt(state.available));
  }

  /**
   * Buy `shares` (e.g. "0.10") custodied at the desk, paid privately: probe a quote, top up desk credit if needed
   * (1% headroom for the price moving), then pay the fresh 402 quote with a voucher. No on-chain transaction.
   */
  async buy(ticker: string, shares: string | number) {
    const probe = await this.quote(ticker, "buy", shares);
    await this.ensureCredit(probe.quote.notional + probe.quote.notional / 100n);
    const res = await this.opts.hush.fetch(this.rfqUrl(ticker, "buy", shares));
    const header = res.headers.get("PAYMENT-RESPONSE");
    if (res.status !== 200 || !header) {
      const body = await res.text().catch(() => "");
      throw new Error(`buy failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const settled = decodePaymentResponseHeader(header);
    const receipts = settled.extra as unknown as RfqSettleExtra;
    const body = (await res.json().catch(() => ({}))) as { quote?: SignedQuoteJson };
    const quote = body.quote ? quoteFromJson(body.quote.quote) : undefined;
    const fill = fillFromJson(receipts.fill.fill);
    const statement = statementFromJson(receipts.statement.statement);
    // The scheme client already verified and stored these; re-check the signatures for the caller.
    const { domain, desk } = await this.ensureTerms();
    if (!(await fillTyped.isValid(domain, fill, receipts.fill.signature)) || !isAddressEqual(fill.desk, desk)) throw new Error("fill not signed by the desk");
    if (quote && fill.quoteId !== quote.quoteId) throw new Error("fill is for another quote");
    return { fill, statement, voucherLeaf: receipts.voucherLeaf, notional: (fill.size * fill.price) / 100n, signedFill: receipts.fill, signedStatement: receipts.statement };
  }

  /** Sell custodied shares: a signed order (zero-increment voucher bound to the sell quote). Proceeds → desk credit. */
  async sell(ticker: string, shares: string | number) {
    const { desk, cfg, domain } = await this.ensureTerms();
    const signed = await this.quote(ticker, "sell", shares);
    const quote = signed.quote;
    const payload = await this.credit.createVoucherPayment(desk, cfg, 0n, quoteRequestHash(domain, quote), `${HUSH_RFQ}:sell:${quote.quoteId}`, {
      allowTopUp: false,
      recordPayment: false,
    });
    let result: { fill: SignedFillJson; statement: SignedStatementJson; voucherLeaf: Hex; credit: CreditStateJson };
    try {
      const res = await this.fetchFn(this.url("sell"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quote: quoteToJson(quote), quoteSignature: signed.signature, payment: payload }),
      });
      result = await this.json(res);
      await this.credit.finishVoucher(payload, { ok: true });
    } catch (err) {
      await this.credit.finishVoucher(payload, { ok: false, reason: (err as Error).message });
      throw err;
    }
    const { statement } = await verifyFillReceipts({ domain, desk, agent: this.agent, quote, fill: result.fill, statement: result.statement, store: this.store });
    await recordFill(this.store, desk, quote, result.fill, result.statement, result.voucherLeaf);
    return { fill: fillFromJson(result.fill.fill), statement, proceeds: quote.notional, credit: result.credit };
  }

  private async authHeaders() {
    const { desk, cfg } = await this.ensureTerms();
    const auth = await creditAuthHeader(this.opts.signer, hushDomain(cfg.chainId, cfg.extra.hushLedger), this.agent, desk);
    return { [CREDIT_AUTH_HEADER]: auth };
  }

  /** Desk-signed custody statements (latest per ticker). Stored locally; signatures checked. */
  async positions(): Promise<DeskPosition[]> {
    const { desk, domain } = await this.ensureTerms();
    const res = await this.json<{ statements: SignedStatementJson[] }>(
      await this.fetchFn(this.url(`positions/${this.agent}`), { headers: await this.authHeaders() }),
    );
    const out: DeskPosition[] = [];
    for (const s of res.statements) {
      const st = statementFromJson(s.statement);
      if (!isAddressEqual(st.desk, desk) || !isAddressEqual(st.agent, this.agent) || !(await statementTyped.isValid(domain, st, s.signature))) {
        throw new Error("desk returned a statement it did not sign for this agent");
      }
      await this.store.addStatement({ desk, statement: s.statement, signature: s.signature, createdAt: Date.now() });
      out.push({ ticker: bytes32ToTicker(st.ticker) as StockTicker, position: st.position, avgCost: st.avgCost, seq: st.seq });
    }
    return out;
  }

  /**
   * Ask the desk to deliver custodied shares as one private eERC transfer (queued for the next cadence tick). The
   * transfer reveals the asset (tokenId) and both addresses — not the size.
   */
  async settleOut(ticker: string, shares: string | number): Promise<{ settleOut: SettleOutJson; statement: PositionStatement }> {
    const { desk, domain } = await this.ensureTerms();
    const t = ticker.toUpperCase();
    if (!isStockTicker(t)) throw new Error(`unknown ticker ${ticker}`);
    const request = {
      requestId: toHex(globalThis.crypto.getRandomValues(new Uint8Array(32))),
      agent: this.agent,
      desk,
      ticker: tickerToBytes32(t),
      size: parseShares(shares),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    };
    const signature = await settleOutTyped.sign(this.opts.signer, domain, request);
    const res = await this.json<{ settleOut: SettleOutJson; statement: SignedStatementJson }>(
      await this.fetchFn(this.url("settle-out"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: settleOutToJson(request), signature }),
      }),
    );
    const statement = statementFromJson(res.statement.statement);
    if (!(await statementTyped.isValid(domain, statement, res.statement.signature)) || !isAddressEqual(statement.desk, desk)) {
      throw new Error("settle-out statement not signed by the desk");
    }
    await this.store.addStatement({ desk, statement: res.statement.statement, signature: res.statement.signature, createdAt: Date.now() });
    await this.store.addSettleOut({ desk, request: settleOutToJson(request), signature, status: "queued", txHash: null, createdAt: Date.now() });
    return { settleOut: res.settleOut, statement };
  }

  /** Settle-out status from the desk (updates the local copies). */
  async settleOuts(): Promise<SettleOutJson[]> {
    const list = await this.json<SettleOutJson[]>(await this.fetchFn(this.url(`settle-outs/${this.agent}`), { headers: await this.authHeaders() }));
    for (const s of list) await this.store.updateSettleOut(s.requestId, { status: s.status, txHash: s.txHash });
    return list;
  }

  /**
   * The agent's own audit of the desk: every statement desk-signed, seq strictly increasing, and each ticker's latest
   * position equal to what the agent's fills and settle-outs add up to. Issues are signed evidence for flagProvider.
   */
  async verifyPositions(opts: { baseline?: Partial<Record<string, bigint>> } = {}): Promise<{ ok: boolean; positions: DeskPosition[]; issues: string[] }> {
    const { desk } = await this.ensureTerms();
    await this.settleOuts().catch(() => undefined);
    const positions = await this.positions();
    const issues: string[] = [];

    const seqs = (await this.store.listStatements()).filter((s) => isAddressEqual(s.desk, desk)).map((s) => BigInt(s.statement.seq)).sort((a, b) => (a < b ? -1 : 1));
    for (let i = 1; i < seqs.length; i++) if (seqs[i] === seqs[i - 1]) issues.push(`duplicate statement seq ${seqs[i]}`);

    // `baseline`: positions accepted from an earlier desk-signed statement (a checkpoint), for an agent whose local
    // ledger doesn't reach back to its first trade.
    const expected = new Map<string, bigint>(Object.entries(opts.baseline ?? {}).map(([t, v]) => [t, v ?? 0n]));
    for (const f of await this.store.listFills()) {
      if (!isAddressEqual(f.desk, desk)) continue;
      const t = bytes32ToTicker(f.fill.ticker);
      expected.set(t, (expected.get(t) ?? 0n) + (Number(f.fill.side) === SIDE.buy ? 1n : -1n) * BigInt(f.fill.size));
    }
    for (const s of await this.store.listSettleOuts()) {
      if (!isAddressEqual(s.desk, desk) || s.status === "failed") continue; // a failed settle-out is put back in custody
      const t = bytes32ToTicker(s.request.ticker);
      expected.set(t, (expected.get(t) ?? 0n) - BigInt(s.request.size));
    }
    for (const [ticker, want] of expected) {
      const got = positions.find((p) => p.ticker === ticker)?.position ?? 0n;
      if (got !== want) issues.push(`${ticker}: desk statement says ${formatShares(got)}, my fills and settle-outs say ${formatShares(want)}`);
    }
    return { ok: issues.length === 0, positions, issues };
  }
}
