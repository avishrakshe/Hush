import { type Address, type Hex, keccak256, stringToBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  SIDE,
  type SignedStatementJson,
  type TradeReport,
  type TradeReportFill,
  alphaDomain,
  fillToJson,
  fillTyped,
  hushDomain,
  quoteRequestHash,
  quoteToJson,
  settleOutToJson,
  settleOutTyped,
  signVoucher,
  statementToJson,
  statementTyped,
  tickerToBytes32,
  verifyTradeReport,
  voucherLeaf,
  voucherToJson,
} from "../src/index.js";

// Well-known Hardhat test keys — never use outside tests.
const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const desk = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const stranger = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");

const CHAIN = 43113;
const HUSH_ALPHA = "0x1111111111111111111111111111111111111111" as Address;
const HUSH_LEDGER = "0x1D6ee5d0AA41f191A361C4306EbCc9E2Aa387577" as Address;
const ORACLE = "0x2222222222222222222222222222222222222222" as Address;
const alpha = alphaDomain(CHAIN, HUSH_ALPHA);
const hush = hushDomain(CHAIN, HUSH_LEDGER);
const MARK = 190_000_000n; // $190

/**
 * A miniature desk: signs quotes' fills and statements with the same average-cost arithmetic as HushDeskService, and
 * the agent signs the vouchers that pay for them. `committed` = the voucher leaves "in HushLedger".
 */
function simulator() {
  let seq = 0n;
  let cumulative = 0n;
  let nonce = 0n;
  let t = 1_800_000_000n;
  const book = new Map<string, { position: bigint; avgCost: bigint }>();
  const report: TradeReport = {
    version: 1,
    kind: "hush-trade-report",
    agent: agent.address,
    desk: desk.address,
    chainId: CHAIN,
    hushAlpha: HUSH_ALPHA,
    hushLedger: HUSH_LEDGER,
    generatedAt: Date.now(),
    fills: [],
    statements: [],
    settleOuts: [],
  };
  const committed = new Set<string>();

  async function statement(ticker: string, delta: bigint, costBasis?: bigint): Promise<SignedStatementJson> {
    const cur = book.get(ticker) ?? { position: 0n, avgCost: 0n };
    const position = cur.position + delta;
    const avgCost = delta > 0n ? (cur.position * cur.avgCost + delta * (costBasis ?? cur.avgCost)) / position : position === 0n ? 0n : cur.avgCost;
    book.set(ticker, { position, avgCost });
    seq++;
    const st = { desk: desk.address, agent: agent.address, ticker: tickerToBytes32(ticker), position, avgCost, seq, issuedAt: t };
    return { statement: statementToJson(st), signature: await statementTyped.sign(desk, alpha, st) };
  }

  return {
    report,
    committed,
    chain: {
      async readContract({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) {
        if (address === HUSH_LEDGER && functionName === "verifyVoucherInclusion") {
          const [, voucher, signature] = args as [bigint, Parameters<typeof voucherLeaf>[0]["voucher"], Hex];
          return committed.has(voucherLeaf({ voucher, signature }));
        }
        if (address === ORACLE && functionName === "latestPrice") return [MARK, t, 1n];
        throw new Error(`unexpected read ${functionName}`);
      },
    },
    async trade(side: "buy" | "sell", ticker: string, size: bigint, price: bigint, opts: { commit?: boolean } = {}): Promise<TradeReportFill> {
      t += 30n;
      const quote = {
        quoteId: keccak256(stringToBytes(`q${t}`)),
        desk: desk.address,
        agent: agent.address,
        ticker: tickerToBytes32(ticker),
        side: side === "buy" ? SIDE.buy : SIDE.sell,
        size,
        price,
        notional: (size * price) / 100n,
        expiry: t + 15n,
      };
      if (side === "buy") cumulative += quote.notional;
      const voucher = { agent: agent.address, provider: desk.address, cumulativeSpent: cumulative, nonce: ++nonce, requestHash: quoteRequestHash(alpha, quote), expiry: t + 600n };
      const vsig = await signVoucher(agent, hush, voucher);
      if (opts.commit !== false) committed.add(voucherLeaf({ voucher, signature: vsig }));
      const fill = { quoteId: quote.quoteId, desk: desk.address, agent: agent.address, ticker: quote.ticker, side: quote.side, size, price, filledAt: t };
      const f: TradeReportFill = {
        fill: fillToJson(fill),
        signature: await fillTyped.sign(desk, alpha, fill),
        quote: quoteToJson(quote),
        voucher: { voucher: voucherToJson(voucher), signature: vsig },
        inclusion: { batchId: "1", proof: [] },
      };
      report.fills.push(f);
      report.statements.push(await statement(ticker, side === "buy" ? size : -size, price));
      return f;
    },
    async settleOut(ticker: string, size: bigint, opts: { fail?: boolean } = {}) {
      t += 30n;
      const request = { requestId: toHex(t, { size: 32 }), agent: agent.address, desk: desk.address, ticker: tickerToBytes32(ticker), size, deadline: t + 300n };
      const leftAt = book.get(ticker)!.avgCost;
      report.statements.push(await statement(ticker, -size));
      report.settleOuts.push({ request: settleOutToJson(request), signature: await settleOutTyped.sign(agent, alpha, request), status: opts.fail ? "failed" : "sent" });
      if (opts.fail) {
        t += 30n;
        report.statements.push(await statement(ticker, size, leftAt));
      }
    },
  };
}

const verify = (s: ReturnType<typeof simulator>) => verifyTradeReport(s.report, { publicClient: s.chain, oracle: ORACLE });

describe("trade reports", () => {
  it("verifies a complete record and recomputes P&L with the desk's arithmetic", async () => {
    const s = simulator();
    await s.trade("buy", "NVDA", 10n, 180_000_000n); // 0.10 @ $180
    await s.trade("buy", "NVDA", 10n, 184_000_000n); // 0.10 @ $184 → avg $182
    await s.trade("sell", "NVDA", 5n, 186_000_000n); // 0.05 @ $186 → +$0.20
    await s.trade("buy", "TSLA", 4n, 250_000_000n);
    await s.trade("sell", "TSLA", 4n, 245_000_000n); // −$0.20
    const r = await verify(s);
    expect(r.valid).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.lastSeq).toBe("5");
    expect(r.linkedToVoucher).toBe(5);
    expect(r.committedOnChain).toBe(5);
    expect(r.buys).toBe(3);
    expect(r.sells).toBe(2);
    const nvda = r.tickers.find((x) => x.ticker === "NVDA")!;
    expect(nvda.position).toBe("15");
    expect(nvda.avgCost).toBe("182000000");
    expect(nvda.realizedPnl).toBe("200000");
    expect(nvda.unrealizedPnl).toBe(((MARK - 182_000_000n) * 15n / 100n).toString()); // $1.20 at $190
    expect(nvda.matchesDesk).toBe(true);
    expect(r.tickers.find((x) => x.ticker === "TSLA")!.realizedPnl).toBe("-200000");
    expect(r.realizedPnl).toBe("0");
  });

  it("catches a dropped losing round trip (two unexplained statements)", async () => {
    const s = simulator();
    await s.trade("buy", "NVDA", 10n, 180_000_000n);
    const loserBuy = await s.trade("buy", "TSLA", 4n, 250_000_000n);
    const loserSell = await s.trade("sell", "TSLA", 4n, 230_000_000n);
    await s.trade("sell", "NVDA", 10n, 185_000_000n);

    // Cherry-picking the fills alone: statements still show the TSLA moves.
    s.report.fills = s.report.fills.filter((f) => f !== loserBuy && f !== loserSell);
    let r = await verify(s);
    expect(r.valid).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.incompleteBecause).toMatch(/seq 2 .*TSLA.* matches no fill/);

    // …and dropping their statements too leaves a gap in the desk's numbering.
    s.report.statements = s.report.statements.filter((x) => x.statement.seq !== "2" && x.statement.seq !== "3");
    r = await verify(s);
    expect(r.complete).toBe(false);
    expect(r.incompleteBecause).toMatch(/missing for seq 2, 3/);
    expect(r.realizedPnl).toBe("500000"); // the flattering number is computed, but flagged as incomplete
  });

  it("rejects a fill whose price was edited after the desk signed it", async () => {
    const s = simulator();
    await s.trade("buy", "NVDA", 10n, 180_000_000n);
    s.report.fills[0]!.fill = { ...s.report.fills[0]!.fill, price: "199000000" };
    const r = await verify(s);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not signed by the desk/);
  });

  it("rejects statements signed by someone other than the desk", async () => {
    const s = simulator();
    await s.trade("buy", "NVDA", 10n, 180_000_000n);
    const st = { ...s.report.statements[0]!.statement };
    const forged = { desk: desk.address, agent: agent.address, ticker: st.ticker, position: 1000n, avgCost: 1n, seq: 1n, issuedAt: BigInt(st.issuedAt) };
    s.report.statements[0] = { statement: statementToJson(forged), signature: await statementTyped.sign(stranger, alpha, forged) };
    const r = await verify(s);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/statement 0 is not signed by the desk/);
  });

  it("rejects a fill whose voucher paid for a different quote", async () => {
    const s = simulator();
    const a = await s.trade("buy", "NVDA", 10n, 180_000_000n);
    const b = await s.trade("buy", "NVDA", 10n, 181_000_000n);
    a.voucher = b.voucher;
    const r = await verify(s);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/voucher did not pay for this quote/);
  });

  it("rejects a claimed HushLedger inclusion that is not on-chain", async () => {
    const s = simulator();
    await s.trade("buy", "NVDA", 10n, 180_000_000n, { commit: false });
    const r = await verify(s);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not in HushLedger batch/);
  });

  it("explains settle-outs and reversed settle-outs", async () => {
    const s = simulator();
    await s.trade("buy", "NVDA", 20n, 180_000_000n);
    await s.settleOut("NVDA", 5n);
    await s.settleOut("NVDA", 5n, { fail: true }); // shares go out, the transfer fails, they come back at cost
    await s.trade("buy", "NVDA", 5n, 190_000_000n);
    const r = await verify(s);
    expect(r.complete).toBe(true);
    expect(r.settleOuts).toBe(2);
    const nvda = r.tickers[0]!;
    expect(nvda.position).toBe("20");
    expect(nvda.avgCost).toBe(((15n * 180_000_000n + 5n * 190_000_000n) / 20n).toString());
    expect(nvda.matchesDesk).toBe(true);
  });

  it("a report signed by a 'desk' the agent controls is refused when the verifier pins the real desk and contracts", async () => {
    const s = simulator();
    await s.trade("buy", "NVDA", 10n, 180_000_000n);
    const anchors = { desk: desk.address, hushLedger: HUSH_LEDGER, hushAlpha: HUSH_ALPHA, chainId: CHAIN };
    expect(await verifyTradeReport(s.report, { publicClient: s.chain, expect: anchors })).toMatchObject({ valid: true });
    // Everything internally consistent, but the "desk" is the stranger's key and the ledger is someone else's contract.
    const forged = { ...s.report, desk: stranger.address };
    expect(await verifyTradeReport(forged, { expect: anchors })).toMatchObject({ valid: false, reason: expect.stringMatching(/not the trusted/) });
    const otherLedger = { ...s.report, hushLedger: "0x4444444444444444444444444444444444444444" as Address };
    expect(await verifyTradeReport(otherLedger, { expect: anchors })).toMatchObject({ valid: false, reason: expect.stringMatching(/HushLedger/) });
  });

  it("reports an empty record as valid and complete", async () => {
    const r = await verify(simulator());
    expect(r).toMatchObject({ valid: true, complete: true, fills: 0, lastSeq: "0", realizedPnl: "0" });
  });
});
