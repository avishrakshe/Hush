import { type Address, type Hex, type PublicClient, formatUnits, hexToString, stringToHex } from "viem";
import { ORACLE_PRICE_DECIMALS, STOCK_TICKERS, type StockTicker } from "./constants.js";
import { mockStockOracleAbi } from "./generated/abis.js";
import type { HushContracts } from "./types.js";

type Reader = Pick<PublicClient, "readContract">;

export const isStockTicker = (v: unknown): v is StockTicker => typeof v === "string" && (STOCK_TICKERS as readonly string[]).includes(v);

/** "NVDA" → bytes32 as MockStock / MockStockOracle store it (UTF-8, right-padded — same as ethers.encodeBytes32String). */
export const tickerToBytes32 = (ticker: string): Hex => stringToHex(ticker, { size: 32 });
export const bytes32ToTicker = (value: Hex): string => hexToString(value, { size: 32 });

/** Oracle price (USDC atomic per share) → "180.25". */
export const formatPrice = (atomic: bigint) => formatUnits(atomic, ORACLE_PRICE_DECIMALS);

export interface OracleRound {
  roundId: bigint;
  /** USDC atomic units (6 dp) per share. */
  price: bigint;
  /** Unix seconds (block time of the update). */
  timestamp: bigint;
}

/** The deployment's stock contracts, or a clear error when the v2 stocks aren't deployed there. */
export function stockContracts(contracts: HushContracts): { oracle: Address; stocks: Partial<Record<StockTicker, Address>> } {
  if (!contracts.stockOracle || !contracts.stocks) {
    throw new Error("this deployment has no mock stocks — run `pnpm deploy:stocks:fuji` (or `pnpm deploy:local`) and `pnpm export:abis`");
  }
  return { oracle: contracts.stockOracle, stocks: contracts.stocks };
}

export async function latestRound(client: Reader, oracle: Address, ticker: string): Promise<OracleRound> {
  const [price, timestamp, roundId] = await client.readContract({
    address: oracle,
    abi: mockStockOracleAbi,
    functionName: "latestPrice",
    args: [tickerToBytes32(ticker)],
  });
  return { roundId, price, timestamp };
}

/** Price in force at `timestamp` (latest round at or before it) — what Proof of Alpha grades against. */
export async function roundAt(client: Reader, oracle: Address, ticker: string, timestamp: bigint): Promise<OracleRound> {
  const [price, roundTimestamp, roundId] = await client.readContract({
    address: oracle,
    abi: mockStockOracleAbi,
    functionName: "getPriceAt",
    args: [tickerToBytes32(ticker), timestamp],
  });
  return { roundId, price, timestamp: roundTimestamp };
}

/** Up to `n` most recent rounds, newest first. */
export async function recentRounds(client: Reader, oracle: Address, ticker: string, n: number): Promise<OracleRound[]> {
  const t = tickerToBytes32(ticker);
  const count = await client.readContract({ address: oracle, abi: mockStockOracleAbi, functionName: "roundCount", args: [t] });
  const ids = Array.from({ length: Math.min(n, Number(count)) }, (_, i) => count - 1n - BigInt(i));
  return Promise.all(
    ids.map(async (roundId) => {
      const [price, timestamp] = await client.readContract({ address: oracle, abi: mockStockOracleAbi, functionName: "getRound", args: [t, roundId] });
      return { roundId, price, timestamp };
    }),
  );
}
