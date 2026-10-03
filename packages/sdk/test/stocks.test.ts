import { describe, expect, it } from "vitest";
import { CENTISHARE, STOCK_TICKERS, bytes32ToTicker, formatPrice, isStockTicker, tickerToBytes32 } from "../src/index.js";

describe("stock helpers", () => {
  it("encodes tickers exactly like the contracts store them (UTF-8, right-padded bytes32)", () => {
    // ethers.encodeBytes32String("NVDA"), which the deploy script and MockStock use.
    expect(tickerToBytes32("NVDA")).toBe(`0x4e564441${"0".repeat(56)}`);
    for (const t of STOCK_TICKERS) expect(bytes32ToTicker(tickerToBytes32(t))).toBe(t);
  });

  it("recognises only the deployed tickers", () => {
    expect(isStockTicker("NVDA")).toBe(true);
    expect(isStockTicker("nvda")).toBe(false);
    expect(isStockTicker("AAPL")).toBe(false);
    expect(isStockTicker(undefined)).toBe(false);
  });

  it("formats oracle prices (USDC atomic per share) and sizes in centishares", () => {
    expect(formatPrice(180_250_000n)).toBe("180.25");
    // 0.01 share = 1 eERC unit = 1e16 token wei.
    expect(10n ** 18n / CENTISHARE).toBe(100n);
  });
});
