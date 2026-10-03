/** Position + P&L bookkeeping (average cost). Sizes in 0.01-share units, prices/money in USDC atomic. */
export class Book {
  private readonly positions = new Map<string, { size: bigint; avgCost: bigint }>();
  private realized = 0n;

  apply(ticker: string, side: "buy" | "sell", size: bigint, price: bigint) {
    const p = this.positions.get(ticker) ?? { size: 0n, avgCost: 0n };
    if (side === "buy") {
      const size2 = p.size + size;
      this.positions.set(ticker, { size: size2, avgCost: (p.size * p.avgCost + size * price) / size2 });
      return;
    }
    const sold = size > p.size ? p.size : size;
    this.realized += (sold * (price - p.avgCost)) / 100n;
    const left = p.size - sold;
    this.positions.set(ticker, { size: left, avgCost: left === 0n ? 0n : p.avgCost });
  }

  size(ticker: string) {
    return this.positions.get(ticker)?.size ?? 0n;
  }

  /** Realized + unrealized at the given marks. */
  pnl(marks: Map<string, bigint>): bigint {
    let unrealized = 0n;
    for (const [ticker, p] of this.positions) {
      const m = marks.get(ticker);
      if (m !== undefined && p.size > 0n) unrealized += (p.size * (m - p.avgCost)) / 100n;
    }
    return this.realized + unrealized;
  }
}
