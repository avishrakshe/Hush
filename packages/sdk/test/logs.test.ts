import { describe, expect, it } from "vitest";
import { MAX_LOG_RANGE, blockRanges, getLogsChunked } from "../src/index.js";

const span = (r: { fromBlock: bigint; toBlock: bigint }) => r.toBlock - r.fromBlock + 1n;

describe("blockRanges", () => {
  it("defaults to the Fuji public RPC cap: 100 blocks fit one request, 101 need two", () => {
    expect(MAX_LOG_RANGE).toBe(100n);
    expect(blockRanges(1n, 100n)).toEqual([{ fromBlock: 1n, toBlock: 100n }]);
    expect(blockRanges(1n, 101n)).toEqual([
      { fromBlock: 1n, toBlock: 100n },
      { fromBlock: 101n, toBlock: 101n },
    ]);
  });

  it("covers the span exactly once, with no range wider than the cap", () => {
    for (const [from, to, max] of [[58_828_806n, 59_701_869n, 100n], [0n, 0n, 100n], [7n, 1_000n, 50_000n], [5n, 99n, 7n]] as const) {
      const ranges = blockRanges(from, to, max);
      expect(ranges[0]!.fromBlock).toBe(from);
      expect(ranges.at(-1)!.toBlock).toBe(to);
      for (const r of ranges) expect(span(r) <= max && span(r) >= 1n).toBe(true);
      for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.fromBlock).toBe(ranges[i - 1]!.toBlock + 1n);
      expect(ranges.reduce((n, r) => n + span(r), 0n)).toBe(to - from + 1n);
    }
  });

  it("is empty when there is nothing to scan, and rejects a zero cap", () => {
    expect(blockRanges(10n, 9n)).toEqual([]);
    expect(() => blockRanges(1n, 5n, 0n)).toThrow(/at least 1 block/);
  });
});

describe("getLogsChunked", () => {
  // A fake RPC that enforces the cap and answers with one "log" per block divisible by 7, after a random delay.
  const rpc = (cap: bigint, seen: bigint[] = []) => async (r: { fromBlock: bigint; toBlock: bigint }) => {
    if (span(r) > cap) throw new Error("block range too large");
    seen.push(r.fromBlock);
    await new Promise((res) => setTimeout(res, Math.random() * 5));
    const logs: bigint[] = [];
    for (let b = r.fromBlock; b <= r.toBlock; b++) if (b % 7n === 0n) logs.push(b);
    return logs;
  };

  it("returns every log in block order even when ranges finish out of order", async () => {
    const logs = await getLogsChunked(1n, 1_234n, rpc(100n), { concurrency: 6 });
    const expected: bigint[] = [];
    for (let b = 1n; b <= 1_234n; b++) if (b % 7n === 0n) expected.push(b);
    expect(logs).toEqual(expected);
  });

  it("honours a wider cap when the RPC allows one (fewer requests)", async () => {
    const seen: bigint[] = [];
    await getLogsChunked(1n, 120_000n, rpc(50_000n, seen), { maxRange: 50_000n });
    expect(seen.length).toBe(3);
  });

  it("fails the whole scan if any range fails, instead of returning a silent partial result", async () => {
    const flaky = async (r: { fromBlock: bigint; toBlock: bigint }) => {
      if (r.fromBlock === 301n) throw new Error("rate limited");
      return [r.fromBlock];
    };
    await expect(getLogsChunked(1n, 1_000n, flaky)).rejects.toThrow("rate limited");
  });

  it("makes no request for an empty span", async () => {
    let calls = 0;
    expect(await getLogsChunked(5n, 4n, async () => (calls++, []))).toEqual([]);
    expect(calls).toBe(0);
  });
});
