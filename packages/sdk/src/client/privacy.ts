/**
 * Privacy knobs for hush-credit top-ups. eERC hides amounts but not the (agent → provider) address pair, so the
 * remaining leaks are top-up size and timing. These options shrink both.
 */
export interface PrivacyOptions {
  /**
   * Top up only in these fixed sizes (USDC atomic). Every agent using the same chunks produces identical-looking
   * top-ups, so a top-up reveals nothing about how much the agent actually intends to spend.
   * Default: 5 and 10 USDC.
   */
  topUpChunks?: bigint[];
  /** Pre-emptively top up when remaining credit falls below this fraction of the smallest chunk. Default 0.25. */
  lowWatermark?: number;
  /**
   * Random delay window [min, max] in ms for pre-emptive top-ups. Top-ups then happen at random times instead of
   * right when a call needs credit, which breaks the "top-up ⇒ burst of calls" timing correlation.
   * Default [5 s, 60 s]. Set [0, 0] to disable pre-emptive top-ups.
   */
  jitterMs?: [number, number];
}

export const DEFAULT_TOP_UP_CHUNKS = [5_000_000n, 10_000_000n];

export function resolvePrivacy(p: PrivacyOptions | undefined) {
  const chunks = [...(p?.topUpChunks ?? DEFAULT_TOP_UP_CHUNKS)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (chunks.length === 0 || chunks.some((c) => c <= 0n)) throw new Error("topUpChunks must be positive amounts");
  return {
    chunks,
    lowWatermark: p?.lowWatermark ?? 0.25,
    jitterMs: p?.jitterMs ?? ([5_000, 60_000] as [number, number]),
  };
}

/** Smallest configured chunk covering `needed` (and the provider's minimum); multiples of the largest otherwise. */
export function pickTopUpChunk(needed: bigint, minTopUp: bigint, chunks: bigint[]): bigint {
  const target = needed > minTopUp ? needed : minTopUp;
  const fit = chunks.find((c) => c >= target);
  if (fit !== undefined) return fit;
  const largest = chunks[chunks.length - 1]!;
  return ((target + largest - 1n) / largest) * largest;
}

/** Uniform random delay using the platform CSPRNG (works in Node and browsers). */
export function randomDelay([min, max]: [number, number]): number {
  if (max <= min) return min;
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return min + Math.floor((buf[0]! / 0x1_0000_0000) * (max - min));
}
