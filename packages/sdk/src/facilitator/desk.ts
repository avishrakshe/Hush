import type { PaymentRequirements } from "@x402/core/types";
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type TypedDataDomain,
  type WalletClient,
  erc20Abi,
  getAddress,
  isAddressEqual,
  toHex,
} from "viem";
import {
  alphaDomain,
  fillToJson,
  formatShares,
  quoteFromJson,
  quoteNotional,
  quoteRequestHash,
  quoteToJson,
  quoteTyped,
  fillTyped,
  settleOutFromJson,
  settleOutTyped,
  statementToJson,
  statementTyped,
} from "../alpha.js";
import { CENTISHARE, DEFAULT_QUOTE_TTL_SECONDS, HUSH_RFQ, SETTLE_OUT_MEMO, SIDE, STOCK_TICKERS, type Side, type StockTicker } from "../constants.js";
import type { TypedDataSigner } from "../eip712.js";
import type { EercAccount } from "../eerc/account.js";
import { bytes32ToTicker, isStockTicker, latestRound, tickerToBytes32 } from "../stocks.js";
import type {
  CreditStateJson,
  FillReceipt,
  HushContracts,
  HushCreditPayload,
  HushRfqExtra,
  Quote,
  SettleOutJson,
  SettleOutRequestJson,
  SignedFillJson,
  SignedQuoteJson,
  SignedStatementJson,
} from "../types.js";
import type { DeskStore, SettleOutRecord, StatementReason } from "./deskStore.js";
import { HushError, type HushProviderService, type VerifyResult } from "./service.js";

export type DeskEvent =
  | { type: "quote"; quoteId: Hex; agent: Address; ticker: StockTicker; side: Side; size: bigint; price: bigint }
  | { type: "fill"; scheme: "hush-rfq" | "exact"; quoteId: Hex; agent: Address; ticker: StockTicker; side: Side; size: bigint; price: bigint; notional: bigint; paymentTx?: Hex; deliveryTx?: Hex }
  | { type: "fill:rejected"; agent?: Address; reason: string; message: string }
  | { type: "settle-out:queued"; requestId: Hex; agent: Address; ticker: StockTicker; size: bigint }
  | { type: "settle-out:sent"; requestId: Hex; agent: Address; ticker: StockTicker; size: bigint; txHash: Hex }
  | { type: "settle-out:failed"; requestId: Hex; agent: Address; ticker: StockTicker; size: bigint; error: string };

export interface HushDeskServiceOptions {
  /** The desk's own provider service: its credit ledger, voucher checks, agent locks and Merkle batches. */
  service: HushProviderService;
  /** The desk key (same wallet as the service's provider). Signs quotes, fills and position statements. */
  signer: TypedDataSigner;
  contracts: HushContracts;
  publicClient: Pick<PublicClient, "readContract" | "waitForTransactionReceipt">;
  store: DeskStore;
  /** The desk's eERC account: encrypted stock inventory for private settle-outs. */
  deskEerc?: EercAccount;
  /** The desk wallet: delivers plain mock stock to public (`exact`) buyers. */
  deskWallet?: WalletClient<Transport, Chain, Account>;
  /** Half-spread around the oracle price, basis points. Default 10 (0.10%). */
  spreadBps?: number;
  quoteTtlSeconds?: number;
  /** Refuse to quote on an oracle price older than this. Default 600 s. */
  maxOracleAgeSeconds?: number;
  /** Largest quote, 0.01-share units. Default 10_000 (100 shares). */
  maxSize?: bigint;
  now?: () => number;
  onEvent?: (e: DeskEvent) => void;
}

export type RfqVerifyResult = (Extract<VerifyResult, { ok: true }> & { quote: Quote }) | Extract<VerifyResult, { ok: false }>;

const CENT = 10_000n; // one cent in USDC atomic units
const ceilTo = (x: bigint, m: bigint) => ((x + m - 1n) / m) * m;
const floorTo = (x: bigint, m: bigint) => (x / m) * m;

/** Promise-chain mutex. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.tail.then(fn, fn);
    this.tail = r.catch(() => undefined);
    return r;
  }
}

/**
 * Hush Desk: a market maker that is just another x402 provider. The 402 *is* the quote (desk-signed, 15 s), paid with
 * a hush-credit voucher against the agent's prepaid hUSDC credit at the desk. The desk then custodies the position and
 * returns a signed FillReceipt + PositionStatement — no on-chain footprint per trade.
 *
 * Why custody instead of delivering hStock per trade: an eERC transfer's calldata carries `tokenId` in plaintext, so
 * per-trade delivery would show every trade's asset and direction. Shares leave custody only on request (settle-out:
 * one private transfer that reveals asset + addresses, not size), batched on the commit cadence.
 *
 * Trust model = hush-credit's (the desk holds prepaid credit and custodied shares). Mitigations: desk-signed quotes,
 * fills and statements (all verifiable on HushAlpha), vouchers bound to quote digests and Merkle-committed to
 * HushLedger, settle-out on demand, and public flagging.
 */
export class HushDeskService {
  readonly desk: Address;
  readonly domain: TypedDataDomain;
  private readonly opts: HushDeskServiceOptions;
  private readonly oracle: Address;
  private readonly stocks: Partial<Record<StockTicker, Address>>;
  private readonly book = new Mutex();
  private readonly inventoryCache = new Map<StockTicker, { units: bigint; at: number }>();
  private settling = false;

  constructor(opts: HushDeskServiceOptions) {
    const { contracts } = opts;
    if (!contracts.hushAlpha || !contracts.stockOracle || !contracts.stocks) {
      throw new Error("the desk needs HushAlpha, MockStockOracle and the mock stocks in this deployment");
    }
    if (contracts.eercDecimals !== 2) throw new Error("the desk assumes eERC decimals = 2 (1 eERC unit = 0.01 share)");
    this.opts = opts;
    this.desk = getAddress(opts.signer.address);
    if (!isAddressEqual(this.desk, opts.service.provider)) throw new Error("desk signer and provider service must be the same wallet");
    this.domain = alphaDomain(contracts.chainId, contracts.hushAlpha);
    this.oracle = contracts.stockOracle;
    this.stocks = contracts.stocks;
  }

  get store() {
    return this.opts.store;
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }
  private nowS() {
    return Math.floor(this.now() / 1000);
  }

  ticker(value: string): StockTicker {
    const t = value.toUpperCase();
    if (!isStockTicker(t) || !this.stocks[t]) throw new HushError("unknown_ticker", `ticker must be one of ${STOCK_TICKERS.join(", ")}`);
    return t;
  }

  stockToken(ticker: StockTicker): Address {
    const token = this.stocks[ticker];
    if (!token) throw new HushError("unknown_ticker", `no ${ticker} token in this deployment`);
    return token;
  }

  // ───────────────────────────── quotes ─────────────────────────────

  /** A firm, desk-signed price: oracle ± spread, rounded to the cent in the desk's favour, valid for 15 s. */
  async quote(args: { agent: Address; ticker: string; side: Side; size: bigint }): Promise<{ quote: Quote; signature: Hex }> {
    const ticker = this.ticker(args.ticker);
    const maxSize = this.opts.maxSize ?? 10_000n;
    if (args.size <= 0n || args.size > maxSize) throw new HushError("invalid_size", `size must be 0.01 – ${formatShares(maxSize)} shares`);
    if (!(args.side in SIDE)) throw new HushError("invalid_side", "side must be buy or sell");

    const round = await latestRound(this.opts.publicClient, this.oracle, ticker);
    const age = this.nowS() - Number(round.timestamp);
    if (age > (this.opts.maxOracleAgeSeconds ?? 600)) {
      throw new HushError("oracle_stale", `${ticker} oracle price is ${age}s old — is the price bot running?`, 503);
    }
    const spread = BigInt(this.opts.spreadBps ?? 10);
    const price =
      args.side === "buy" ? ceilTo((round.price * (10_000n + spread)) / 10_000n, CENT) : floorTo((round.price * (10_000n - spread)) / 10_000n, CENT);

    const quote: Quote = {
      quoteId: toHex(globalThis.crypto.getRandomValues(new Uint8Array(32))),
      desk: this.desk,
      agent: getAddress(args.agent),
      ticker: tickerToBytes32(ticker),
      side: SIDE[args.side],
      size: args.size,
      price,
      notional: quoteNotional(args.size, price),
      expiry: BigInt(this.nowS() + (this.opts.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS)),
    };
    const signature = await quoteTyped.sign(this.opts.signer, this.domain, quote);
    this.emit({ type: "quote", quoteId: quote.quoteId, agent: quote.agent, ticker, side: args.side, size: args.size, price });
    return { quote, signature };
  }

  /** Re-checks a quote the desk issued: its signature, arithmetic, expiry, that it is unused, and who it was for. */
  async checkQuote(signed: SignedQuoteJson | { quote: Quote; signature: Hex }, expect: { agent?: Address; side?: Side } = {}): Promise<Quote> {
    let quote: Quote;
    try {
      quote = typeof signed.quote.size === "string" ? quoteFromJson(signed.quote as SignedQuoteJson["quote"]) : (signed.quote as Quote);
    } catch {
      throw new HushError("invalid_quote", "malformed quote");
    }
    if (!isAddressEqual(quote.desk, this.desk) || !(await quoteTyped.isValid(this.domain, quote, signed.signature))) {
      throw new HushError("invalid_quote", "quote was not signed by this desk");
    }
    if (quote.notional !== quoteNotional(quote.size, quote.price)) throw new HushError("invalid_quote", "quote notional does not match size × price");
    if (Number(quote.expiry) < this.nowS()) throw new HushError("quote_expired", "quote expired — ask for a new one");
    if (expect.agent && !isAddressEqual(quote.agent, expect.agent)) throw new HushError("quote_agent_mismatch", "quote was issued to another agent", 403);
    if (expect.side && quote.side !== SIDE[expect.side]) throw new HushError("invalid_quote", `expected a ${expect.side} quote`);
    if (await this.opts.store.isQuoteUsed(quote.quoteId)) throw new HushError("quote_used", "quote already filled", 409);
    this.ticker(bytes32ToTicker(quote.ticker));
    return quote;
  }

  // ───────────────────────────── hush-rfq buys (custodied) ─────────────────────────────

  /** x402 verify for hush-rfq: the quote is genuine and live, and the voucher pays exactly its notional against credit. */
  async verifyRfq(payload: HushCreditPayload, req: PaymentRequirements): Promise<RfqVerifyResult> {
    const agent = payload?.voucher?.agent ? getAddress(payload.voucher.agent) : undefined;
    const fail = (code: string, message: string) => ({ ok: false as const, code, message, agent });
    const extra = (req.extra ?? {}) as Partial<HushRfqExtra>;
    if (!extra.quote || !extra.quoteSignature) return fail("invalid_quote", "requirements carry no desk quote");

    let quote: Quote;
    try {
      quote = await this.checkQuote({ quote: extra.quote, signature: extra.quoteSignature }, { agent, side: "buy" });
    } catch (err) {
      return err instanceof HushError ? fail(err.code, err.message) : fail("invalid_quote", (err as Error).message);
    }
    if (BigInt(req.amount) !== quote.notional) return fail("amount_mismatch", "requirements amount differs from the quote notional");

    const v = await this.opts.service.verifyVoucher(payload, req, undefined, { scheme: HUSH_RFQ, requestHash: quoteRequestHash(this.domain, quote) });
    if (!v.ok) return v;
    const capacity = await this.custodyShortfall(this.ticker(bytes32ToTicker(quote.ticker)), quote.size);
    if (capacity) return fail("desk_capacity", capacity);
    return { ...v, quote };
  }

  /** x402 settle for hush-rfq: consume the voucher and book the position — atomically, under the agent's lock. */
  async settleRfq(payload: HushCreditPayload, req: PaymentRequirements) {
    const agent = getAddress(payload.voucher.agent);
    return this.opts.service.withAgentLock(agent, () =>
      this.book.run(async () => {
        const v = await this.verifyRfq(payload, req);
        if (!v.ok) {
          this.emit({ type: "fill:rejected", agent, reason: v.code, message: v.message });
          return v;
        }
        const { quote } = v;
        if (!(await this.opts.store.useQuote(quote.quoteId, agent, this.now()))) {
          return { ok: false as const, code: "quote_used", message: "quote already filled", agent };
        }
        const paid = await this.opts.service.recordVoucher(v, payload, `${HUSH_RFQ}:${quote.quoteId}`);
        const ticker = this.ticker(bytes32ToTicker(quote.ticker));
        const statement = await this.issueStatement(agent, ticker, quote.size, "buy", quote.price);
        const fill = await this.recordFill(quote, HUSH_RFQ, { voucherLeaf: paid.leaf });
        return { ok: true as const, leaf: paid.leaf, credit: paid.credit, quote, fill, statement };
      }),
    );
  }

  // ───────────────────────────── sells ─────────────────────────────

  /**
   * Sell custodied shares at a desk sell quote. The order is a zero-increment voucher whose requestHash is the quote
   * digest: no money moves from the agent, but the order still lands in the desk's next Merkle batch. Proceeds are
   * credited to the agent's hUSDC credit at the desk (instant, off-chain; refundable privately).
   */
  async sell(signed: SignedQuoteJson, payload: HushCreditPayload) {
    const agent = getAddress(payload.voucher.agent);
    return this.opts.service.withAgentLock(agent, () =>
      this.book.run(async () => {
        const quote = await this.checkQuote(signed, { agent, side: "sell" });
        const ticker = this.ticker(bytes32ToTicker(quote.ticker));
        const req = {
          scheme: HUSH_RFQ,
          network: `eip155:${this.opts.contracts.chainId}`,
          asset: this.opts.contracts.usdc,
          amount: "0",
          payTo: this.desk,
          maxTimeoutSeconds: 60,
          extra: {},
        } as PaymentRequirements;
        const v = await this.opts.service.verifyVoucher(payload, req, undefined, { scheme: HUSH_RFQ, requestHash: quoteRequestHash(this.domain, quote) });
        if (!v.ok) throw new HushError(v.code, v.message, 402);
        if (v.increment !== 0n) throw new HushError("invalid_order", "a sell order's voucher must not add to cumulativeSpent");
        const position = await this.opts.store.getPosition(agent, ticker);
        if (position.position < quote.size) {
          throw new HushError("insufficient_position", `holding ${formatShares(position.position)} ${ticker}, selling ${formatShares(quote.size)}`);
        }
        if (!(await this.opts.store.useQuote(quote.quoteId, agent, this.now()))) throw new HushError("quote_used", "quote already filled", 409);

        const paid = await this.opts.service.recordVoucher(v, payload, `${HUSH_RFQ}:sell:${quote.quoteId}`);
        const statement = await this.issueStatement(agent, ticker, -quote.size, "sell");
        const credit = await this.opts.service.creditProceeds(agent, quote.notional);
        const fill = await this.recordFill(quote, HUSH_RFQ, { voucherLeaf: paid.leaf });
        return { fill, statement, voucherLeaf: paid.leaf, credit: this.opts.service.toJson(credit) as CreditStateJson };
      }),
    );
  }

  // ───────────────────────────── public `exact` buys ─────────────────────────────

  /**
   * Before an `exact` (EIP-3009) payment settles: the echoed quote must be this desk's, live, unused and issued to the
   * payer, and the desk must hold the plain tokens to deliver. Consumes the quote, so a quote is filled at most once.
   */
  async reservePublicFill(signed: SignedQuoteJson, payer: Address): Promise<Quote> {
    return this.book.run(async () => {
      const quote = await this.checkQuote(signed, { agent: getAddress(payer), side: "buy" });
      const token = this.stockToken(this.ticker(bytes32ToTicker(quote.ticker)));
      const held = await this.opts.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [this.desk] });
      if (held < quote.size * CENTISHARE) throw new HushError("desk_capacity", "desk is out of public inventory for this ticker", 503);
      if (!(await this.opts.store.useQuote(quote.quoteId, quote.agent, this.now()))) throw new HushError("quote_used", "quote already filled", 409);
      return quote;
    });
  }

  /** After the `exact` payment settled: deliver plain tokens publicly — the baseline every observer (and Mirror) sees. */
  async deliverPublicFill(quote: Quote, paymentTx: Hex): Promise<{ fill: SignedFillJson; deliveryTx: Hex }> {
    const wallet = this.opts.deskWallet;
    if (!wallet) throw new Error("public delivery needs `deskWallet`");
    const ticker = this.ticker(bytes32ToTicker(quote.ticker));
    const deliveryTx = await wallet.writeContract({
      address: this.stockToken(ticker),
      abi: erc20Abi,
      functionName: "transfer",
      args: [quote.agent, quote.size * CENTISHARE],
    });
    const receipt = await this.opts.publicClient.waitForTransactionReceipt({ hash: deliveryTx });
    if (receipt.status !== "success") throw new Error(`delivery reverted: ${deliveryTx}`);
    const fill = await this.recordFill(quote, "exact", { paymentTx, deliveryTx });
    return { fill, deliveryTx };
  }

  // ───────────────────────────── custody ─────────────────────────────

  /** Latest signed statement per ticker for `agent` (callers must have authenticated the agent or its owner). */
  async positions(agent: Address): Promise<{ agent: Address; lastSeq: string; statements: SignedStatementJson[] }> {
    const all = await this.opts.store.listStatements(getAddress(agent));
    const latest = new Map<string, SignedStatementJson>();
    for (const s of all) if (!latest.has(s.ticker)) latest.set(s.ticker, { statement: s.statement, signature: s.signature });
    return { agent: getAddress(agent), lastSeq: (all[0]?.seq ?? 0n).toString(), statements: [...latest.values()] };
  }

  /**
   * Agent (or owner) asks for custodied shares to be delivered as a private eERC transfer. The shares leave custody now
   * (a new signed statement); the transfer itself runs on the next cadence tick with other agents' settle-outs.
   */
  async requestSettleOut(json: SettleOutRequestJson, signature: Hex): Promise<{ settleOut: SettleOutJson; statement: SignedStatementJson }> {
    let request: ReturnType<typeof settleOutFromJson>;
    try {
      request = settleOutFromJson(json);
    } catch {
      throw new HushError("invalid_request", "malformed settle-out request");
    }
    if (!isAddressEqual(request.desk, this.desk)) throw new HushError("wrong_provider", "request is for another desk");
    if (Number(request.deadline) < this.nowS()) throw new HushError("expired_request", "settle-out request expired");
    if (request.size <= 0n) throw new HushError("invalid_size", "size must be positive");
    const ticker = this.ticker(bytes32ToTicker(request.ticker));
    const agent = getAddress(request.agent);
    const signer = await settleOutTyped.recover(this.domain, request, signature).catch(() => undefined);
    if (!signer || !(await this.opts.service.isAgentOrOwner(agent, signer))) {
      throw new HushError("invalid_signature", "settle-out must be signed by the agent or its owner", 401);
    }

    return this.opts.service.withAgentLock(agent, () =>
      this.book.run(async () => {
        if (await this.opts.store.hasSettleOut(request.requestId)) throw new HushError("duplicate_request", "settle-out already requested", 409);
        const position = await this.opts.store.getPosition(agent, ticker);
        if (position.position < request.size) {
          throw new HushError("insufficient_position", `holding ${formatShares(position.position)} ${ticker}, asked for ${formatShares(request.size)}`);
        }
        const statement = await this.issueStatement(agent, ticker, -request.size, "settle-out");
        const record: SettleOutRecord = {
          requestId: request.requestId,
          agent,
          ticker,
          size: request.size,
          avgCost: position.avgCost,
          status: "queued",
          txHash: null,
          request: json,
          signature,
          createdAt: this.now(),
          executedAt: null,
          error: null,
        };
        await this.opts.store.addSettleOut(record);
        this.emit({ type: "settle-out:queued", requestId: request.requestId, agent, ticker, size: request.size });
        return { settleOut: toSettleOutJson(record), statement };
      }),
    );
  }

  /** Executes queued settle-outs, one private eERC transfer each (the desk account can only have one in flight). */
  async processSettleOuts(): Promise<SettleOutJson[]> {
    const eerc = this.opts.deskEerc;
    if (!eerc || this.settling) return [];
    this.settling = true;
    const done: SettleOutJson[] = [];
    try {
      for (const r of await this.opts.store.listSettleOuts({ status: "queued" })) {
        try {
          // 1 eERC unit = 0.01 share (eERC decimals 2), so the size in centishares is the transfer amount.
          const { txHash } = await eerc.transfer(r.agent, r.size, SETTLE_OUT_MEMO, this.stockToken(r.ticker));
          await this.opts.store.updateSettleOut(r.requestId, { status: "sent", txHash, executedAt: this.now() });
          this.inventoryCache.delete(r.ticker);
          this.emit({ type: "settle-out:sent", requestId: r.requestId, agent: r.agent, ticker: r.ticker, size: r.size, txHash });
          done.push(toSettleOutJson({ ...r, status: "sent", txHash, executedAt: this.now() }));
        } catch (err) {
          const error = (err as Error).message.split("\n")[0]!.slice(0, 300);
          // The shares never left: put them back in custody under a new statement.
          await this.opts.service.withAgentLock(r.agent, () =>
            this.book.run(() => this.issueStatement(r.agent, r.ticker, r.size, "settle-out-reversed", r.avgCost)),
          );
          await this.opts.store.updateSettleOut(r.requestId, { status: "failed", error, executedAt: this.now() });
          this.emit({ type: "settle-out:failed", requestId: r.requestId, agent: r.agent, ticker: r.ticker, size: r.size, error });
          done.push(toSettleOutJson({ ...r, status: "failed", error, executedAt: this.now() }));
        }
      }
    } finally {
      this.settling = false;
    }
    return done;
  }

  async settleOuts(agent: Address): Promise<SettleOutJson[]> {
    return (await this.opts.store.listSettleOuts({ agent })).map(toSettleOutJson);
  }

  /** Desk inventory per ticker: what it custodies for agents vs. what it holds (encrypted and plain). */
  async inventory() {
    const out = [];
    for (const ticker of STOCK_TICKERS) {
      const token = this.stocks[ticker];
      if (!token) continue;
      const plain = await this.opts.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [this.desk] });
      out.push({
        ticker,
        custodied: formatShares(await this.custodied(ticker)),
        privateInventory: this.opts.deskEerc ? formatShares(await this.privateInventory(ticker)) : null,
        publicInventory: formatShares(plain / CENTISHARE),
      });
    }
    return out;
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** Shares held for agents + shares queued to leave (still in the encrypted inventory until sent). */
  private async custodied(ticker: StockTicker): Promise<bigint> {
    const held = (await this.opts.store.listPositions()).filter((p) => p.ticker === ticker).reduce((s, p) => s + p.position, 0n);
    const leaving = (await this.opts.store.listSettleOuts({ status: "queued" })).filter((r) => r.ticker === ticker).reduce((s, r) => s + r.size, 0n);
    return held + leaving;
  }

  private async privateInventory(ticker: StockTicker): Promise<bigint> {
    const cached = this.inventoryCache.get(ticker);
    if (cached && this.now() - cached.at < 30_000) return cached.units;
    const units = (await this.opts.deskEerc!.balance(this.desk, this.stockToken(ticker))).decrypted;
    this.inventoryCache.set(ticker, { units, at: this.now() });
    return units;
  }

  /** Custody stays fully backed by the desk's encrypted inventory, so every position can actually be settled out. */
  private async custodyShortfall(ticker: StockTicker, size: bigint): Promise<string | undefined> {
    if (!this.opts.deskEerc) return undefined;
    const [held, inventory] = await Promise.all([this.custodied(ticker), this.privateInventory(ticker)]);
    if (held + size > inventory) return `desk can custody ${formatShares(inventory - held)} more ${ticker} (asked ${formatShares(size)})`;
    return undefined;
  }

  /** New signed statement for (agent, ticker) after `delta` centishares; seq strictly increases per agent. */
  private async issueStatement(agent: Address, ticker: StockTicker, delta: bigint, reason: StatementReason, costBasis?: bigint): Promise<SignedStatementJson> {
    const cur = await this.opts.store.getPosition(agent, ticker);
    let position: bigint;
    let avgCost: bigint;
    if (delta > 0n) {
      position = cur.position + delta;
      avgCost = (cur.position * cur.avgCost + delta * (costBasis ?? cur.avgCost)) / position;
    } else {
      if (cur.position < -delta) throw new HushError("insufficient_position", `holding ${formatShares(cur.position)} ${ticker}`);
      position = cur.position + delta;
      avgCost = position === 0n ? 0n : cur.avgCost;
    }
    const seq = (await this.opts.store.lastSeq(agent)) + 1n;
    const statement = { desk: this.desk, agent, ticker: tickerToBytes32(ticker), position, avgCost, seq, issuedAt: BigInt(this.nowS()) };
    const signature = await statementTyped.sign(this.opts.signer, this.domain, statement);
    const json = statementToJson(statement);
    await this.opts.store.addStatement({ agent, seq, ticker, position, avgCost, reason, statement: json, signature, issuedAt: this.now() });
    return { statement: json, signature };
  }

  private async recordFill(quote: Quote, scheme: "hush-rfq" | "exact", refs: { voucherLeaf?: Hex; paymentTx?: Hex; deliveryTx?: Hex }): Promise<SignedFillJson> {
    const fill: FillReceipt = {
      quoteId: quote.quoteId,
      desk: this.desk,
      agent: quote.agent,
      ticker: quote.ticker,
      side: quote.side,
      size: quote.size,
      price: quote.price,
      filledAt: BigInt(this.nowS()),
    };
    const signature = await fillTyped.sign(this.opts.signer, this.domain, fill);
    const ticker = this.ticker(bytes32ToTicker(quote.ticker));
    const side: Side = quote.side === SIDE.sell ? "sell" : "buy";
    await this.opts.store.addFill({
      quoteId: quote.quoteId,
      agent: quote.agent,
      ticker,
      side,
      size: quote.size,
      price: quote.price,
      notional: quote.notional,
      scheme,
      filledAt: this.now(),
      fill: fillToJson(fill),
      signature,
      voucherLeaf: refs.voucherLeaf ?? null,
      paymentTx: refs.paymentTx ?? null,
      deliveryTx: refs.deliveryTx ?? null,
    });
    this.emit({ type: "fill", scheme, quoteId: quote.quoteId, agent: quote.agent, ticker, side, size: quote.size, price: quote.price, notional: quote.notional, ...refs });
    return { fill: fillToJson(fill), signature };
  }

  private emit(e: DeskEvent) {
    try {
      this.opts.onEvent?.(e);
    } catch {
      // listeners never break trading
    }
  }
}

export function toSettleOutJson(r: SettleOutRecord): SettleOutJson {
  return {
    requestId: r.requestId,
    agent: r.agent,
    ticker: r.ticker,
    size: formatShares(r.size),
    status: r.status,
    txHash: r.txHash,
    createdAt: r.createdAt,
    executedAt: r.executedAt,
    ...(r.error && { error: r.error }),
  };
}

/** Quote → the `AssetAmount.extra` the desk's 402 carries (plus the exact scheme's EIP-712 USDC domain when needed). */
export const quoteExtra = (signed: { quote: Quote; signature: Hex }) => ({ quote: quoteToJson(signed.quote), quoteSignature: signed.signature });
