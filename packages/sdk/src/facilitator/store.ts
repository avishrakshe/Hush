import type { Address, Hex } from "viem";
import type { CreditReceiptJson, VoucherJson } from "../types.js";

/** Credit for one (agent, provider) pair. All amounts USDC atomic units; totals only ever grow. */
export interface CreditRecord {
  agent: Address;
  provider: Address;
  /** Sum of all decrypted top-ups. */
  creditedTotal: bigint;
  /** Sum of all refunds sent back (requested or expired). */
  refundedTotal: bigint;
  /** cumulativeSpent of the last settled voucher. */
  settledCumulative: bigint;
  /** v2: sale proceeds the desk credited back to the agent (always 0 for API providers). */
  proceedsTotal: bigint;
  lastNonce: bigint;
  lastTopUpAt: number | null;
}

export interface TopUpRecord {
  txHash: Hex;
  agent: Address;
  provider: Address;
  /** Who sent the eERC transfer: the agent, or its owner's treasury. */
  payer: Address;
  amount: bigint;
  blockNumber: bigint;
  receipt: CreditReceiptJson;
  signature: Hex;
  createdAt: number;
}

export interface SettledVoucherRecord {
  leaf: Hex;
  agent: Address;
  provider: Address;
  voucher: VoucherJson;
  signature: Hex;
  /** Increment charged by this voucher. */
  amount: bigint;
  resource: string;
  settledAt: number;
  batchId: bigint | null;
  proof: Hex[] | null;
}

export interface BatchRecord {
  provider: Address;
  batchId: bigint;
  root: Hex;
  txHash: Hex;
  voucherCount: number;
  /** True for padding batches committed when no vouchers were consumed (hides activity timing). */
  dummy: boolean;
  committedAt: number;
}

export interface RefundRecord {
  id: string;
  agent: Address;
  provider: Address;
  amount: bigint;
  txHash: Hex | null;
  reason: "requested" | "expired";
  status: "sent" | "failed";
  createdAt: number;
}

export interface DirectPaymentRecord {
  txHash: Hex;
  agent: Address;
  provider: Address;
  amount: bigint;
  resource: string;
  settledAt: number;
}

/**
 * Facilitator persistence. The facilitator serializes all mutations per agent, so implementations only need
 * atomic single operations. MemoryCreditStore for tests; apps/facilitator ships a SQLite implementation.
 */
export interface CreditStore {
  getCredit(agent: Address, provider: Address): Promise<CreditRecord>;
  putCredit(record: CreditRecord): Promise<void>;
  listCredits(provider: Address): Promise<CreditRecord[]>;

  hasTopUp(txHash: Hex): Promise<boolean>;
  addTopUp(t: TopUpRecord): Promise<void>;
  listTopUps(filter?: { agent?: Address; limit?: number }): Promise<TopUpRecord[]>;

  addSettledVoucher(v: SettledVoucherRecord): Promise<void>;
  listUnbatchedVouchers(provider: Address): Promise<SettledVoucherRecord[]>;
  getVoucher(leaf: Hex): Promise<SettledVoucherRecord | undefined>;
  listVouchers(filter?: { agent?: Address; limit?: number }): Promise<SettledVoucherRecord[]>;

  addBatch(b: BatchRecord, proofs: Map<string, Hex[]>): Promise<void>;
  getBatch(provider: Address, batchId: bigint): Promise<BatchRecord | undefined>;
  listBatches(provider: Address, limit?: number): Promise<BatchRecord[]>;

  addRefund(r: RefundRecord): Promise<void>;
  listRefunds(filter?: { agent?: Address; limit?: number }): Promise<RefundRecord[]>;

  hasDirectPayment(txHash: Hex): Promise<boolean>;
  addDirectPayment(p: DirectPaymentRecord): Promise<void>;
}

export const emptyCredit = (agent: Address, provider: Address): CreditRecord => ({
  agent,
  provider,
  creditedTotal: 0n,
  refundedTotal: 0n,
  settledCumulative: 0n,
  proceedsTotal: 0n,
  lastNonce: 0n,
  lastTopUpAt: null,
});

const key = (...parts: string[]) => parts.map((p) => p.toLowerCase()).join(":");
const newestFirst = <T extends { createdAt?: number; settledAt?: number }>(a: T, b: T) =>
  (b.createdAt ?? b.settledAt ?? 0) - (a.createdAt ?? a.settledAt ?? 0);

export class MemoryCreditStore implements CreditStore {
  private credits = new Map<string, CreditRecord>();
  private topUps = new Map<string, TopUpRecord>();
  private vouchers = new Map<string, SettledVoucherRecord>();
  private batches = new Map<string, BatchRecord>();
  private refunds: RefundRecord[] = [];
  private direct = new Map<string, DirectPaymentRecord>();

  async getCredit(agent: Address, provider: Address) {
    return { ...(this.credits.get(key(agent, provider)) ?? emptyCredit(agent, provider)) };
  }
  async putCredit(r: CreditRecord) {
    this.credits.set(key(r.agent, r.provider), { ...r });
  }
  async listCredits(provider: Address) {
    return [...this.credits.values()].filter((c) => c.provider.toLowerCase() === provider.toLowerCase());
  }
  async hasTopUp(txHash: Hex) {
    return this.topUps.has(txHash.toLowerCase());
  }
  async addTopUp(t: TopUpRecord) {
    if (this.topUps.has(t.txHash.toLowerCase())) throw new Error("duplicate top-up");
    this.topUps.set(t.txHash.toLowerCase(), t);
  }
  async listTopUps(f?: { agent?: Address; limit?: number }) {
    return [...this.topUps.values()]
      .filter((t) => !f?.agent || t.agent.toLowerCase() === f.agent.toLowerCase())
      .sort(newestFirst)
      .slice(0, f?.limit ?? Number.POSITIVE_INFINITY);
  }
  async addSettledVoucher(v: SettledVoucherRecord) {
    this.vouchers.set(v.leaf.toLowerCase(), v);
  }
  async listUnbatchedVouchers(provider: Address) {
    return [...this.vouchers.values()].filter((v) => v.batchId === null && v.provider.toLowerCase() === provider.toLowerCase());
  }
  async getVoucher(leaf: Hex) {
    return this.vouchers.get(leaf.toLowerCase());
  }
  async listVouchers(f?: { agent?: Address; limit?: number }) {
    return [...this.vouchers.values()]
      .filter((v) => !f?.agent || v.agent.toLowerCase() === f.agent.toLowerCase())
      .sort(newestFirst)
      .slice(0, f?.limit ?? Number.POSITIVE_INFINITY);
  }
  async addBatch(b: BatchRecord, proofs: Map<string, Hex[]>) {
    this.batches.set(key(b.provider, b.batchId.toString()), b);
    for (const [leaf, proof] of proofs) {
      const v = this.vouchers.get(leaf.toLowerCase());
      if (v) Object.assign(v, { batchId: b.batchId, proof });
    }
  }
  async getBatch(provider: Address, batchId: bigint) {
    return this.batches.get(key(provider, batchId.toString()));
  }
  async listBatches(provider: Address, limit = 50) {
    return [...this.batches.values()]
      .filter((b) => b.provider.toLowerCase() === provider.toLowerCase())
      .sort((a, b) => b.committedAt - a.committedAt)
      .slice(0, limit);
  }
  async addRefund(r: RefundRecord) {
    this.refunds.push(r);
  }
  async listRefunds(f?: { agent?: Address; limit?: number }) {
    return this.refunds
      .filter((r) => !f?.agent || r.agent.toLowerCase() === f.agent.toLowerCase())
      .sort(newestFirst)
      .slice(0, f?.limit ?? Number.POSITIVE_INFINITY);
  }
  async hasDirectPayment(txHash: Hex) {
    return this.direct.has(txHash.toLowerCase());
  }
  async addDirectPayment(p: DirectPaymentRecord) {
    this.direct.set(p.txHash.toLowerCase(), p);
  }
}
