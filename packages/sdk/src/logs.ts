/**
 * eth_getLogs over long spans, in bounded block ranges. Every log scan in Hush goes through here because RPCs cap the
 * span of one request: Fuji's public RPC (api.avax-test.network) allows 100 blocks since Oct 2026 (it was 2048), others
 * allow more (publicnode: 50 000). Callers pass the cap of the RPC they use; the default fits any of them.
 */

export type BlockRange = { fromBlock: bigint; toBlock: bigint };

/** Widest inclusive span (`toBlock - fromBlock + 1`) the Fuji public RPC accepts in one getLogs request. */
export const MAX_LOG_RANGE = 100n;

/** Inclusive ranges of at most `maxRange` blocks that exactly cover `fromBlock..toBlock` (none if from > to). */
export function blockRanges(fromBlock: bigint, toBlock: bigint, maxRange: bigint = MAX_LOG_RANGE): BlockRange[] {
  if (maxRange < 1n) throw new Error(`maxRange must be at least 1 block (got ${maxRange})`);
  const out: BlockRange[] = [];
  for (let from = fromBlock; from <= toBlock; from += maxRange) {
    const to = from + maxRange - 1n;
    out.push({ fromBlock: from, toBlock: to < toBlock ? to : toBlock });
  }
  return out;
}

/**
 * Runs `query` on every range of `fromBlock..toBlock` and concatenates the results in block order. Ranges run
 * `concurrency` at a time (default 4): a long backfill finishes quickly without tripping a public RPC's rate limit.
 * The first failing range rejects the whole scan — a partial result would silently hide events.
 */
export async function getLogsChunked<T>(
  fromBlock: bigint,
  toBlock: bigint,
  query: (range: BlockRange) => Promise<readonly T[]>,
  opts: { maxRange?: bigint; concurrency?: number } = {},
): Promise<T[]> {
  const ranges = blockRanges(fromBlock, toBlock, opts.maxRange);
  const results: (readonly T[])[] = new Array(ranges.length);
  let next = 0;
  const worker = async () => {
    while (next < ranges.length) {
      const i = next++;
      results[i] = await query(ranges[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, opts.concurrency ?? 4), ranges.length) }, worker));
  return results.flat();
}
