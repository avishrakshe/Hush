/**
 * Trade reports — an agent proves its private trading record to someone it chooses (an investor, an auditor, a
 * counterparty) without anything about it ever being public.
 *
 * The agent hands over what the desk signed for it: every FillReceipt, every PositionStatement, its settle-out requests,
 * and for each fill the quote and the agent's own voucher that paid (buy) or ordered (sell) it, with the Merkle proof of
 * that voucher in a HushLedger batch root. The verifier checks:
 *   - signatures: fills + statements by the desk, vouchers + settle-outs by the agent;
 *   - binding: voucher.requestHash = the quote's EIP-712 digest and fill.quoteId = quote.quoteId, so each fill is the
 *     trade that voucher paid for — and the voucher sits in a root the desk committed on-chain at batch time, which
 *     pins the fill in time (it can't be back-dated or invented later);
 *   - completeness: the desk numbers statements 1, 2, 3, … per agent and issues one per position change. The report
 *     must contain every seq up to the last, and each step must be explained by exactly one fill, settle-out or
 *     reversal. Dropping a losing round trip leaves two unexplained seqs, so cherry-picking shows.
 * Then P&L is recomputed with the desk's own average-cost arithmetic and marked at the oracle.
 *
 * Trust: the desk is the counterparty and signs everything — an agent colluding with its desk could fabricate a
 * history. Against everyone else (including the agent alone) the record is tamper-evident.
 * viem only: runs in Node and in the browser.
 */
import { type Address, type Hex, type PublicClient, isAddressEqual } from "viem";
import { alphaDomain, fillFromJson, fillTyped, quoteFromJson, quoteRequestHash, settleOutFromJson, settleOutTyped, statementFromJson, statementTyped } from "./alpha.js";
import { SIDE } from "./constants.js";
import { hushDomain, recoverVoucherSigner, voucherFromJson } from "./eip712.js";
import { hushLedgerAbi } from "./generated/abis.js";
import { voucherLeaf } from "./merkle.js";
import { bytes32ToTicker, latestRound } from "./stocks.js";
import type { FillReceiptJson, QuoteJson, SettleOutRequestJson, SignedStatementJson, VoucherJson, VoucherProofJson } from "./types.js";

export interface TradeReportFill {
  fill: FillReceiptJson;
  signature: Hex;
  /** The quote this fill executed (fills recorded before V5 lack it). */
  quote?: QuoteJson;
  /** The agent's voucher that paid (buy) or ordered (sell) the fill. */
  voucher?: { voucher: VoucherJson; signature: Hex };
  /** Where that voucher was committed: HushLedger batch + Merkle proof. */
  inclusion?: { batchId: string; proof: Hex[] };
}

export interface TradeReport {
  version: 1;
  kind: "hush-trade-report";
  agent: Address;
  desk: Address;
  chainId: number;
  hushAlpha: Address;
  hushLedger: Address;
  generatedAt: number;
  fills: TradeReportFill[];
  statements: SignedStatementJson[];
  settleOuts: { request: SettleOutRequestJson; signature: Hex; status: "queued" | "sent" | "failed" }[];
}

/** What the agent's HushStore holds (structural, so this module stays free of the client package). */
interface ReportSource {
  listFills(): Promise<{ desk: Address; fill: FillReceiptJson; signature: Hex; voucherLeaf: Hex | null; quote?: QuoteJson }[]>;
  listStatements(): Promise<{ desk: Address; statement: SignedStatementJson["statement"]; signature: Hex }[]>;
  listSettleOuts(): Promise<{ desk: Address; request: SettleOutRequestJson; signature: Hex; status: "queued" | "sent" | "failed" }[]>;
  listVouchers(): Promise<{ leaf: Hex; voucher: VoucherJson; signature: Hex }[]>;
}

/**
 * Collects the agent's record at one desk from its own store. `proof(leaf)` (the desk facilitator's GET /proof/:leaf)
 * adds the HushLedger inclusion proofs; vouchers whose batch isn't committed yet go without one.
 */
export async function buildTradeReport(opts: {
  store: ReportSource;
  agent: Address;
  desk: Address;
  chainId: number;
  hushAlpha: Address;
  hushLedger: Address;
  proof?: (leaf: Hex) => Promise<VoucherProofJson | null>;
}): Promise<TradeReport> {
  const mine = <T extends { desk: Address }>(xs: T[]) => xs.filter((x) => isAddressEqual(x.desk, opts.desk));
  const [fills, statements, settleOuts, vouchers] = await Promise.all([
    opts.store.listFills().then(mine),
    opts.store.listStatements().then(mine),
    opts.store.listSettleOuts().then(mine),
    opts.store.listVouchers(),
  ]);
  const byLeaf = new Map(vouchers.map((v) => [v.leaf.toLowerCase(), v]));
  const seen = new Set<string>();
  return {
    version: 1,
    kind: "hush-trade-report",
    agent: opts.agent,
    desk: opts.desk,
    chainId: opts.chainId,
    hushAlpha: opts.hushAlpha,
    hushLedger: opts.hushLedger,
    generatedAt: Date.now(),
    fills: await Promise.all(
      fills
        .filter((f) => isAddressEqual(f.fill.agent, opts.agent))
        .map(async (f): Promise<TradeReportFill> => {
          const v = f.voucherLeaf ? byLeaf.get(f.voucherLeaf.toLowerCase()) : undefined;
          const p = v && opts.proof ? await opts.proof(v.leaf).catch(() => null) : null;
          return {
            fill: f.fill,
            signature: f.signature,
            ...(f.quote && { quote: f.quote }),
            ...(v && { voucher: { voucher: v.voucher, signature: v.signature } }),
            ...(p && { inclusion: { batchId: p.batchId, proof: p.proof } }),
          };
        }),
    ),
    statements: statements
      .filter((s) => isAddressEqual(s.statement.agent, opts.agent))
      .filter((s) => !seen.has(s.statement.seq) && seen.add(s.statement.seq))
      .map((s) => ({ statement: s.statement, signature: s.signature })),
    settleOuts: settleOuts.map((s) => ({ request: s.request, signature: s.signature, status: s.status })),
  };
}

export interface TickerSummary {
  ticker: string;
  /** Custodied 0.01-share units and average cost (USDC atomic per share), per the desk's last statement. */
  position: string;
  avgCost: string;
  /** Realized P&L from sells against the running average cost (USDC atomic). */
  realizedPnl: string;
  /** Oracle mark (USDC atomic per share) and unrealized P&L of the position at it. */
  mark: string | null;
  unrealizedPnl: string | null;
  /** The recomputed position and average cost equal the desk's last statement. */
  matchesDesk: boolean;
}

export interface TradeReportResult {
  /** Every signature and link holds. */
  valid: boolean;
  reason?: string;
  /** valid, statements 1..lastSeq all present, and every step explained by exactly one event. */
  complete: boolean;
  incompleteBecause?: string;
  agent: Address;
  desk: Address;
  lastSeq: string;
  fills: number;
  buys: number;
  sells: number;
  settleOuts: number;
  /** Fills tied to the agent's voucher through the quote digest. */
  linkedToVoucher: number;
  /** …of which the voucher is inside a HushLedger root (checked on-chain). */
  committedOnChain: number;
  boughtNotional: string;
  soldNotional: string;
  realizedPnl: string;
  unrealizedPnl: string | null;
  firstFillAt: number | null;
  lastFillAt: number | null;
  tickers: TickerSummary[];
}

type Event =
  | { kind: "buy" | "sell"; ticker: string; size: bigint; price: bigint; at: bigint; idx: number }
  | { kind: "settle-out" | "reversal"; ticker: string; size: bigint; idx: number };

/**
 * Verifies a trade report. With `publicClient`, inclusion proofs are checked against HushLedger on-chain; with `oracle`
 * too, open positions are marked at MockStockOracle's latest price. Never throws on bad input — returns valid: false.
 */
export async function verifyTradeReport(
  report: TradeReport,
  opts: { publicClient?: Pick<PublicClient, "readContract">; oracle?: Address } = {},
): Promise<TradeReportResult> {
  const result: TradeReportResult = {
    valid: false,
    complete: false,
    agent: report.agent,
    desk: report.desk,
    lastSeq: "0",
    fills: report.fills?.length ?? 0,
    buys: 0,
    sells: 0,
    settleOuts: report.settleOuts?.length ?? 0,
    linkedToVoucher: 0,
    committedOnChain: 0,
    boughtNotional: "0",
    soldNotional: "0",
    realizedPnl: "0",
    unrealizedPnl: null,
    firstFillAt: null,
    lastFillAt: null,
    tickers: [],
  };
  const fail = (reason: string): TradeReportResult => ({ ...result, valid: false, complete: false, reason });
  if (report?.version !== 1 || report.kind !== "hush-trade-report") return fail("not a version-1 hush trade report");

  try {
    const alpha = alphaDomain(report.chainId, report.hushAlpha);
    const hush = hushDomain(report.chainId, report.hushLedger);
    const { agent, desk } = report;

    // ─── fills: desk-signed, this agent's, tied to its quote and voucher ───
    const fills = [];
    let bought = 0n;
    let sold = 0n;
    for (const [i, f] of report.fills.entries()) {
      const fill = fillFromJson(f.fill);
      if (!isAddressEqual(fill.desk, desk) || !isAddressEqual(fill.agent, agent)) return fail(`fill ${i} is for another desk or agent`);
      if (!(await fillTyped.isValid(alpha, fill, f.signature))) return fail(`fill ${i} is not signed by the desk (forged or altered)`);
      if (f.quote) {
        const q = quoteFromJson(f.quote);
        const same =
          q.quoteId === fill.quoteId && isAddressEqual(q.desk, desk) && isAddressEqual(q.agent, agent) &&
          q.ticker.toLowerCase() === fill.ticker.toLowerCase() && q.side === fill.side && q.size === fill.size && q.price === fill.price;
        if (!same) return fail(`fill ${i} does not match its quote`);
        if (f.voucher) {
          const v = voucherFromJson(f.voucher.voucher);
          if (!isAddressEqual(v.agent, agent) || !isAddressEqual(v.provider, desk)) return fail(`fill ${i}: voucher is for another agent or desk`);
          if (v.requestHash.toLowerCase() !== quoteRequestHash(alpha, q).toLowerCase()) return fail(`fill ${i}: voucher did not pay for this quote`);
          if (!isAddressEqual(await recoverVoucherSigner(hush, v, f.voucher.signature), agent)) return fail(`fill ${i}: voucher not signed by the agent`);
          result.linkedToVoucher++;
          if (f.inclusion && opts.publicClient) {
            const ok = (await opts.publicClient.readContract({
              address: report.hushLedger,
              abi: hushLedgerAbi,
              functionName: "verifyVoucherInclusion",
              args: [BigInt(f.inclusion.batchId), v, f.voucher.signature, f.inclusion.proof],
            })) as boolean;
            if (!ok) return fail(`fill ${i}: voucher ${voucherLeaf({ voucher: v, signature: f.voucher.signature })} is not in HushLedger batch ${f.inclusion.batchId}`);
            result.committedOnChain++;
          }
        }
      }
      const notional = (fill.size * fill.price) / 100n;
      if (fill.side === SIDE.buy) {
        result.buys++;
        bought += notional;
      } else {
        result.sells++;
        sold += notional;
      }
      fills.push({ fill, idx: i });
    }
    result.boughtNotional = bought.toString();
    result.soldNotional = sold.toString();
    const times = fills.map((f) => Number(f.fill.filledAt));
    result.firstFillAt = times.length ? Math.min(...times) : null;
    result.lastFillAt = times.length ? Math.max(...times) : null;

    // ─── settle-outs: agent-signed ───
    const settleOuts = [];
    for (const [i, s] of report.settleOuts.entries()) {
      const r = settleOutFromJson(s.request);
      if (!isAddressEqual(r.agent, agent) || !isAddressEqual(r.desk, desk)) return fail(`settle-out ${i} is for another agent or desk`);
      if (!(await settleOutTyped.isValid(alpha, r, s.signature))) return fail(`settle-out ${i} is not signed by the agent`);
      settleOuts.push({ ticker: bytes32ToTicker(r.ticker), size: r.size, failed: s.status === "failed", idx: i });
    }

    // ─── statements: desk-signed, one per seq ───
    const statements = [];
    for (const [i, s] of report.statements.entries()) {
      const st = statementFromJson(s.statement);
      if (!isAddressEqual(st.desk, desk) || !isAddressEqual(st.agent, agent)) return fail(`statement ${i} is for another desk or agent`);
      if (!(await statementTyped.isValid(alpha, st, s.signature))) return fail(`statement ${i} is not signed by the desk`);
      statements.push(st);
    }
    statements.sort((a, b) => (a.seq < b.seq ? -1 : 1));
    for (let i = 1; i < statements.length; i++) {
      if (statements[i]!.seq === statements[i - 1]!.seq) return fail(`two different statements carry seq ${statements[i]!.seq}`);
    }
    result.valid = true;
    const lastSeq = statements.at(-1)?.seq ?? 0n;
    result.lastSeq = lastSeq.toString();

    // ─── completeness: walk seq 1..N, explaining each position change by one event ───
    let incomplete: string | undefined;
    const missing = [];
    for (let s = 1n, k = 0; s <= lastSeq; s++) {
      if (statements[k]?.seq === s) k++;
      else missing.push(s);
    }
    if (missing.length) incomplete = `statements missing for seq ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`;

    const usedFill = new Set<number>();
    const usedSettle = new Set<number>();
    const usedReversal = new Set<number>();
    const events: Event[] = [];
    const prevPos = new Map<string, bigint>();
    if (!incomplete) {
      const byTime = [...fills].sort((a, b) => (a.fill.filledAt < b.fill.filledAt ? -1 : a.fill.filledAt > b.fill.filledAt ? 1 : 0));
      for (const st of statements) {
        const t = bytes32ToTicker(st.ticker);
        const delta = st.position - (prevPos.get(t) ?? 0n);
        prevPos.set(t, st.position);
        const side = delta > 0n ? SIDE.buy : SIDE.sell;
        const size = delta > 0n ? delta : -delta;
        // The desk signs a fill and its statement in the same request (same clock, about a second apart): take the
        // closest matching fill within 5 s, so a reversal and a same-size buy a moment later aren't confused.
        const gap = (at: bigint) => (at > st.issuedAt ? at - st.issuedAt : st.issuedAt - at);
        const f = byTime
          .filter((x) => !usedFill.has(x.idx) && bytes32ToTicker(x.fill.ticker) === t && x.fill.side === side && x.fill.size === size && gap(x.fill.filledAt) <= 5n)
          .sort((a, b) => (gap(a.fill.filledAt) < gap(b.fill.filledAt) ? -1 : 1))[0];
        if (delta !== 0n && f) {
          usedFill.add(f.idx);
          events.push({ kind: side === SIDE.buy ? "buy" : "sell", ticker: t, size, price: f.fill.price, at: f.fill.filledAt, idx: f.idx });
          continue;
        }
        const so =
          delta < 0n
            ? settleOuts.find((x) => !usedSettle.has(x.idx) && x.ticker === t && x.size === size)
            : settleOuts.find((x) => x.failed && usedSettle.has(x.idx) && !usedReversal.has(x.idx) && x.ticker === t && x.size === size);
        if (delta !== 0n && so) {
          (delta < 0n ? usedSettle : usedReversal).add(so.idx);
          events.push({ kind: delta < 0n ? "settle-out" : "reversal", ticker: t, size, idx: so.idx });
          continue;
        }
        incomplete = `statement seq ${st.seq} (${t} ${delta >= 0n ? "+" : ""}${delta}) matches no fill or settle-out in the report`;
        break;
      }
      const stray = fills.find((f) => !usedFill.has(f.idx));
      if (!incomplete && stray) incomplete = `fill ${stray.idx} is not reflected in any statement`;
    }

    // ─── P&L with the desk's average-cost arithmetic ───
    // Complete reports replay events in seq order (exactly the desk's book); otherwise fills in time order.
    const replay: Event[] = incomplete
      ? fills
          .sort((a, b) => (a.fill.filledAt < b.fill.filledAt ? -1 : 1))
          .map((f) => ({ kind: f.fill.side === SIDE.buy ? "buy" : "sell", ticker: bytes32ToTicker(f.fill.ticker), size: f.fill.size, price: f.fill.price, at: f.fill.filledAt, idx: f.idx }) as Event)
      : events;
    const book = new Map<string, { position: bigint; avgCost: bigint; realized: bigint; lastSettleAvg: Map<number, bigint> }>();
    for (const e of replay) {
      const b = book.get(e.ticker) ?? { position: 0n, avgCost: 0n, realized: 0n, lastSettleAvg: new Map() };
      book.set(e.ticker, b);
      if (e.kind === "buy" || e.kind === "reversal") {
        const cost = e.kind === "buy" ? e.price : (b.lastSettleAvg.get(e.idx) ?? b.avgCost);
        const next = b.position + e.size;
        b.avgCost = (b.position * b.avgCost + e.size * cost) / next;
        b.position = next;
      } else {
        if (e.kind === "sell") b.realized += ((e.price - b.avgCost) * e.size) / 100n;
        else b.lastSettleAvg.set(e.idx, b.avgCost); // a reversal puts shares back at the cost they left with
        b.position -= e.size;
        if (b.position <= 0n) {
          b.position = 0n;
          b.avgCost = 0n;
        }
      }
    }

    const lastByTicker = new Map<string, (typeof statements)[number]>();
    for (const st of statements) lastByTicker.set(bytes32ToTicker(st.ticker), st);
    const tickers = [...new Set([...book.keys(), ...lastByTicker.keys()])].sort();
    let realized = 0n;
    let unrealized: bigint | null = 0n;
    for (const t of tickers) {
      const b = book.get(t) ?? { position: 0n, avgCost: 0n, realized: 0n };
      const st = lastByTicker.get(t);
      const position = st?.position ?? b.position;
      const avgCost = st?.avgCost ?? b.avgCost;
      let mark: bigint | null = null;
      if (opts.publicClient && opts.oracle && position > 0n) mark = (await latestRound(opts.publicClient, opts.oracle, t)).price;
      const u = position === 0n ? 0n : mark === null ? null : ((mark - avgCost) * position) / 100n;
      realized += b.realized;
      unrealized = unrealized === null || u === null ? null : unrealized + u;
      result.tickers.push({
        ticker: t,
        position: position.toString(),
        avgCost: avgCost.toString(),
        realizedPnl: b.realized.toString(),
        mark: mark?.toString() ?? null,
        unrealizedPnl: u?.toString() ?? null,
        matchesDesk: !incomplete && !!st && b.position === st.position && b.avgCost === st.avgCost,
      });
    }
    result.realizedPnl = realized.toString();
    result.unrealizedPnl = unrealized?.toString() ?? null;
    if (!incomplete) {
      const off = result.tickers.find((t) => !t.matchesDesk);
      if (off) incomplete = `${off.ticker}: replaying the events does not reproduce the desk's last statement`;
    }
    result.complete = !incomplete;
    if (incomplete) result.incompleteBecause = incomplete;
    return result;
  } catch (err) {
    return fail(`malformed report: ${(err as Error).message.split("\n")[0]}`);
  }
}
