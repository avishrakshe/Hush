import type { Address, Hex } from "viem";
import type { CreditReceiptJson, HushCreditExtra, VoucherJson } from "../types.js";

/** Every paid call, any scheme — the basis for daily caps and the agent's spend history. */
export interface StoredPayment {
  /** Voucher leaf (hush-credit), eERC tx hash (hush-direct) or EIP-3009 nonce (exact). */
  id: string;
  scheme: string;
  provider: Address;
  /** USDC atomic units. */
  amount: string;
  resource: string;
  at: number;
}

/** The agent's own copy of each voucher it signed — kept to verify on-chain inclusion later. */
export interface StoredVoucher {
  leaf: Hex;
  voucher: VoucherJson;
  signature: Hex;
  resource: string;
  /** Increment paid by this voucher (USDC atomic). */
  amount: string;
  status: "signed" | "settled" | "rejected";
  createdAt: number;
  batchId?: string;
  /** Set once HushLedger confirmed the voucher is inside a committed batch. */
  verifiedOnChain?: boolean;
}

export interface StoredReceipt {
  receipt: CreditReceiptJson;
  signature: Hex;
  /** Amount this top-up credited (USDC atomic). */
  amount: string;
  payer: Address;
  createdAt: number;
  /** The provider's hush-credit terms at top-up time, so refunds/verification work after a restart. */
  terms?: { extra: HushCreditExtra; chainId: number };
}

export interface StoredRefund {
  provider: Address;
  txHash: Hex | null;
  amount: string;
  createdAt: number;
}

/**
 * Persistence for an agent's private payment history. Only the agent (and its owner) ever hold this data;
 * MemoryHushStore for tests/browsers, JsonFileHushStore (from "@hush/x402/node") for long-running agents.
 */
export interface HushStore {
  addPayment(p: StoredPayment): Promise<void>;
  listPayments(): Promise<StoredPayment[]>;
  addVoucher(v: StoredVoucher): Promise<void>;
  updateVoucher(leaf: Hex, patch: Partial<StoredVoucher>): Promise<void>;
  listVouchers(): Promise<StoredVoucher[]>;
  addReceipt(r: StoredReceipt): Promise<void>;
  listReceipts(): Promise<StoredReceipt[]>;
  addRefund(r: StoredRefund): Promise<void>;
  listRefunds(): Promise<StoredRefund[]>;
}

export interface HushStoreData {
  payments: StoredPayment[];
  vouchers: StoredVoucher[];
  receipts: StoredReceipt[];
  refunds: StoredRefund[];
}

export const emptyStoreData = (): HushStoreData => ({ payments: [], vouchers: [], receipts: [], refunds: [] });

export class MemoryHushStore implements HushStore {
  protected data: HushStoreData;

  constructor(initial?: HushStoreData) {
    this.data = initial ?? emptyStoreData();
  }

  /** Called after every mutation; subclasses persist here. */
  protected async persist(): Promise<void> {}

  async addPayment(p: StoredPayment) {
    this.data.payments.push(p);
    await this.persist();
  }
  async listPayments() {
    return [...this.data.payments];
  }
  async addVoucher(v: StoredVoucher) {
    this.data.vouchers.push(v);
    await this.persist();
  }
  async updateVoucher(leaf: Hex, patch: Partial<StoredVoucher>) {
    const v = this.data.vouchers.find((x) => x.leaf.toLowerCase() === leaf.toLowerCase());
    if (v) Object.assign(v, patch);
    await this.persist();
  }
  async listVouchers() {
    return [...this.data.vouchers];
  }
  async addReceipt(r: StoredReceipt) {
    this.data.receipts.push(r);
    await this.persist();
  }
  async listReceipts() {
    return [...this.data.receipts];
  }
  async addRefund(r: StoredRefund) {
    this.data.refunds.push(r);
    await this.persist();
  }
  async listRefunds() {
    return [...this.data.refunds];
  }
}
