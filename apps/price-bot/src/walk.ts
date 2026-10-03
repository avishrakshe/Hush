/**
 * Synthetic price model for the mock stocks. Per tick, for each ticker:
 *
 *   r_t = φ·r_{t-1} + θ·(ln μ − ln p_{t-1}) + σ·z_t        p_t = p_{t-1}·e^{r_t}
 *
 * θ pulls the price back toward its anchor μ (so a demo left running for days stays near realistic levels), σ is the
 * per-tick volatility (exaggerated so moves are visible within a signal's horizon), and φ adds mild momentum: returns
 * are autocorrelated, so a momentum signal has a real but modest edge and an honest provider's verified record looks
 * like a plausible one rather than a coin flip. Seeded, so a run is reproducible. Synthetic data — not a market model.
 */
export interface WalkParams {
  /** Anchor price in USD the walk reverts to. */
  anchor: number;
  /** Per-tick volatility of log returns. */
  sigma: number;
  /** Per-tick mean-reversion strength. */
  theta: number;
  /** Return autocorrelation (momentum). */
  phi: number;
}

export const DEFAULT_PARAMS: Record<string, WalkParams> = {
  NVDA: { anchor: 180, sigma: 0.004, theta: 0.01, phi: 0.25 },
  TSLA: { anchor: 250, sigma: 0.006, theta: 0.01, phi: 0.25 },
  SPY: { anchor: 570, sigma: 0.0015, theta: 0.01, phi: 0.25 },
};

/** mulberry32: tiny, fast, good enough for a reproducible demo walk. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller. */
export function gaussian(uniform: () => number) {
  const u = Math.max(uniform(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
}

export class PriceWalk {
  private lastReturn = 0;
  constructor(
    private price: number,
    private readonly p: WalkParams,
  ) {}

  get current() {
    return this.price;
  }

  step(z: number): number {
    const r = this.p.phi * this.lastReturn + this.p.theta * (Math.log(this.p.anchor) - Math.log(this.price)) + this.p.sigma * z;
    this.lastReturn = r;
    this.price *= Math.exp(r);
    return this.price;
  }
}

/** USD → USDC atomic (6 dp), rounded to whole cents so posted prices read like real quotes. */
export const toAtomicCents = (usd: number) => BigInt(Math.max(1, Math.round(usd * 100))) * 10_000n;
