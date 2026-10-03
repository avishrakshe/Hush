import { publicClient } from "@hush/config";
import { CENTISHARE, type EercAccount, type HushContracts, eercToAtomic, formatShares, formatUsdc, mockStockAbi, mockUsdcAbi } from "@hush/x402";
import type { HushDeskClient, HushPublicDesk, HushStore } from "@hush/x402/client";
import type { Address } from "viem";

/** One executed trade, as the agent reports it. Sizes in 0.01-share units, money in USDC atomic. */
export interface VenueTrade {
  side: "buy" | "sell";
  size: bigint;
  price: bigint;
  notional: bigint;
  /** What this trade left on-chain — the whole point of the Atlas/Veil comparison. */
  footprint: string;
  /** Atlas: the public payment / payout tx. Veil: the voucher leaf (off-chain, committed later in a Merkle root). */
  reference: string;
  ms: number;
}

/** Where an agent trades. Atlas and Veil run the same strategy; only this differs. */
export interface Venue {
  readonly label: string;
  position(): Promise<{ size: bigint; avgCost: bigint | null }>;
  /** USDC (atomic) the agent can trade with right now. */
  cash(): Promise<bigint>;
  buy(shares: string): Promise<VenueTrade>;
  sell(shares: string): Promise<VenueTrade>;
}

/**
 * Atlas: the desk's public path. Buys pay the 402 quote with x402 `exact` and receive plain mStock; sells transfer
 * plain mStock and receive USDC. Its position is just its token balance — anyone can read it.
 */
export class PublicVenue implements Venue {
  readonly label = "public x402 `exact` at the Hush Desk — USDC and mStock both move on-chain";
  private avgCost: bigint | null = null;

  constructor(
    private readonly ticker: string,
    private readonly desk: HushPublicDesk,
    private readonly contracts: HushContracts,
    private readonly me: Address,
  ) {}

  async position() {
    const token = this.contracts.stocks![this.ticker as keyof NonNullable<HushContracts["stocks"]>]!;
    const bal = await publicClient.readContract({ address: token, abi: mockStockAbi, functionName: "balanceOf", args: [this.me] });
    const size = bal / CENTISHARE;
    return { size, avgCost: size === 0n ? null : this.avgCost };
  }

  async cash() {
    return publicClient.readContract({ address: this.contracts.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [this.me] });
  }

  async buy(shares: string): Promise<VenueTrade> {
    const before = (await this.position()).size;
    const t0 = performance.now();
    const t = await this.desk.buy(this.ticker, shares);
    // Running average cost of what this session knows it holds (the chain only knows the balance).
    this.avgCost = before === 0n || this.avgCost === null ? t.price : (before * this.avgCost + t.size * t.price) / (before + t.size);
    return {
      side: "buy",
      size: t.size,
      price: t.price,
      notional: t.notional,
      footprint: `public: ${formatUsdc(t.notional)} → desk, ${formatShares(t.size)} m${this.ticker} desk → agent`,
      reference: t.paymentTx,
      ms: Math.round(performance.now() - t0),
    };
  }

  async sell(shares: string): Promise<VenueTrade> {
    const t0 = performance.now();
    const t = await this.desk.sell(this.ticker, shares);
    return {
      side: "sell",
      size: t.size,
      price: t.price,
      notional: t.notional,
      footprint: `public: ${formatShares(t.size)} m${this.ticker} → desk, ${formatUsdc(t.notional)} desk → agent`,
      reference: t.paymentTx,
      ms: Math.round(performance.now() - t0),
    };
  }
}

/**
 * Veil: the Hush Desk's private path (hush-rfq). Trades are vouchers against prepaid encrypted credit; the desk custodies
 * the position and signs statements. On-chain: an occasional fixed-size encrypted top-up, nothing per trade.
 */
export class PrivateVenue implements Venue {
  readonly label = "Hush Desk via hush-rfq — vouchers off-chain, position custodied, encrypted top-ups only";
  private cached: { size: bigint; avgCost: bigint | null } | undefined;

  constructor(
    private readonly ticker: string,
    private readonly desk: HushDeskClient,
    private readonly eerc: EercAccount,
    private readonly contracts: HushContracts,
    private readonly store: HushStore,
  ) {}

  async position() {
    try {
      const p = (await this.desk.positions()).find((x) => x.ticker === this.ticker);
      this.cached = p ? { size: p.position, avgCost: p.position === 0n ? null : p.avgCost } : { size: 0n, avgCost: null };
    } catch {
      // first contact with the desk (no terms yet) or the desk is down — fall back to the last statement we saw
    }
    return this.cached ?? { size: 0n, avgCost: null };
  }

  async cash() {
    const wallet = eercToAtomic((await this.eerc.balance()).decrypted, this.contracts.eercDecimals);
    const atDesk = await this.desk.creditState().then((c) => BigInt(c.available)).catch(() => 0n);
    return wallet + atDesk;
  }

  private async trade(side: "buy" | "sell", shares: string): Promise<VenueTrade> {
    const topUpsBefore = (await this.store.listReceipts()).length;
    const t0 = performance.now();
    const r = side === "buy" ? await this.desk.buy(this.ticker, shares) : await this.desk.sell(this.ticker, shares);
    const ms = Math.round(performance.now() - t0);
    const toppedUp = (await this.store.listReceipts()).length > topUpsBefore;
    this.cached = { size: r.statement.position, avgCost: r.statement.position === 0n ? null : r.statement.avgCost };
    const notional = (r.fill.size * r.fill.price) / 100n;
    return {
      side,
      size: r.fill.size,
      price: r.fill.price,
      notional,
      footprint: toppedUp ? "one encrypted top-up to the desk (amount hidden), the trade itself off-chain" : "none — voucher off-chain, position custodied",
      reference: "voucherLeaf" in r ? r.voucherLeaf : "",
      ms,
    };
  }

  buy(shares: string) {
    return this.trade("buy", shares);
  }

  sell(shares: string) {
    return this.trade("sell", shares);
  }
}
