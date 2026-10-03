import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  type Quote,
  alphaDomain,
  fillToJson,
  fillTyped,
  parseShares,
  formatShares,
  statementToJson,
  statementTyped,
  tickerToBytes32,
} from "../src/index.js";
import { MemoryHushStore, TradePolicyViolation, assertTradePolicy, verifyFillReceipts } from "../src/client/index.js";

const agent = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const desk = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const stranger = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
const domain = alphaDomain(43113, "0x1111111111111111111111111111111111111111");
const NVDA = tickerToBytes32("NVDA");

const quote = (size: bigint, price = 180_000_000n, side = 1): Quote => ({
  quoteId: `0x${"ab".repeat(32)}`,
  desk: desk.address,
  agent: agent.address,
  ticker: NVDA,
  side,
  size,
  price,
  notional: (size * price) / 100n,
  expiry: BigInt(Math.floor(Date.now() / 1000) + 15),
});

async function receipts(q: Quote, position: bigint, seq: bigint, signer = desk) {
  const fill = { quoteId: q.quoteId, desk: desk.address, agent: agent.address, ticker: q.ticker, side: q.side, size: q.size, price: q.price, filledAt: 1n };
  const statement = { desk: desk.address, agent: agent.address, ticker: q.ticker, position, avgCost: q.price, seq, issuedAt: 1n };
  return {
    fill: { fill: fillToJson(fill), signature: await fillTyped.sign(signer, domain, fill) },
    statement: { statement: statementToJson(statement), signature: await statementTyped.sign(signer, domain, statement) },
  };
}

describe("share units", () => {
  it("parses and formats 0.01-share amounts", () => {
    expect(parseShares("0.10")).toBe(10n);
    expect(parseShares("12")).toBe(1_200n);
    expect(parseShares(0.5)).toBe(50n);
    expect(formatShares(5n)).toBe("0.05");
    expect(() => parseShares("0.001")).toThrow(/max 2 decimals/);
  });
});

describe("TradePolicy (checked before the agent signs)", () => {
  it("enforces tickers, desks, per-trade notional, position and daily caps", async () => {
    const store = new MemoryHushStore();
    const q = quote(10n); // 0.10 × $180 = $18
    await expect(assertTradePolicy({ allowedTickers: ["TSLA"] }, store, desk.address, q)).rejects.toBeInstanceOf(TradePolicyViolation);
    await expect(assertTradePolicy({ allowedDesks: [stranger.address] }, store, desk.address, q)).rejects.toMatchObject({ reason: "desk_not_allowed" });
    await expect(assertTradePolicy({ maxNotionalPerTrade: 17_999_999n }, store, desk.address, q)).rejects.toMatchObject({ reason: "over_per_trade_max" });
    await assertTradePolicy({ maxNotionalPerTrade: 18_000_000n, allowedTickers: ["NVDA"] }, store, desk.address, q);

    const r = await receipts(q, 10n, 1n);
    await store.addStatement({ desk: desk.address, ...r.statement, createdAt: Date.now() });
    await store.addFill({ desk: desk.address, ...r.fill, notional: q.notional.toString(), voucherLeaf: null, createdAt: Date.now() });
    await expect(assertTradePolicy({ maxPosition: 15n }, store, desk.address, quote(6n))).rejects.toMatchObject({ reason: "over_position_max" });
    await assertTradePolicy({ maxPosition: 15n }, store, desk.address, quote(5n));
    await expect(assertTradePolicy({ dailyNotionalCap: 30_000_000n }, store, desk.address, q)).rejects.toMatchObject({ reason: "over_daily_cap" });
    // Sells only reduce exposure: caps don't apply.
    await assertTradePolicy({ maxNotionalPerTrade: 1n, dailyNotionalCap: 1n }, store, desk.address, quote(10n, 180_000_000n, 2));
  });
});

describe("verifyFillReceipts (the agent checks what the desk returns)", () => {
  it("accepts desk-signed receipts that match the quote and continue the statement sequence", async () => {
    const store = new MemoryHushStore();
    const q = quote(10n);
    const out = await verifyFillReceipts({ domain, desk: desk.address, agent: agent.address, quote: q, ...(await receipts(q, 10n, 1n)), store });
    expect(out.statement.position).toBe(10n);
  });

  it("rejects receipts signed by someone else, for another quote, or with wrong arithmetic or seq", async () => {
    const store = new MemoryHushStore();
    const q = quote(10n);
    const base = { domain, desk: desk.address, agent: agent.address, quote: q, store };
    await expect(verifyFillReceipts({ ...base, ...(await receipts(q, 10n, 1n, stranger)) })).rejects.toThrow(/not signed by the desk/);
    await expect(verifyFillReceipts({ ...base, ...(await receipts({ ...q, size: 11n }, 11n, 1n)) })).rejects.toThrow(/does not match the quote/);
    await expect(verifyFillReceipts({ ...base, ...(await receipts(q, 12n, 1n)) })).rejects.toThrow(/expected 10/);

    const first = await receipts(q, 10n, 1n);
    await store.addStatement({ desk: desk.address, ...first.statement, createdAt: Date.now() });
    await expect(verifyFillReceipts({ ...base, ...(await receipts(q, 20n, 1n)) })).rejects.toThrow(/does not advance/);
    await verifyFillReceipts({ ...base, ...(await receipts(q, 20n, 2n)) });
  });
});
