import type { Address, Hex } from "viem";
import type {
  CreditReceiptJson,
  FillReceiptJson,
  HushCreditExtra,
  PositionStatementJson,
  SettleOutRequestJson,
  VoucherJson,
} from "../types.js";

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

/** v2: a desk-signed fill the agent received (its private trade log). */
export interface StoredFill {
  desk: Address;
  fill: FillReceiptJson;
  signature: Hex;
  /** USDC atomic. */
  notional: string;
  /** The voucher that paid (buy) or ordered (sell) it. */
  voucherLeaf: Hex | null;
  createdAt: number;
}

/** v2: a desk-signed custody statement the agent received. */
export interface StoredStatement {
  desk: Address;
  statement: PositionStatementJson;
  signature: Hex;
  createdAt: number;
}

/** v2: a settle-out the agent requested (custodied shares → private eERC transfer). */
export interface StoredSettleOut {
  desk: Address;
  request: SettleOutRequestJson;
  signature: Hex;
  status: "queued" | "sent" | "failed";
  txHash: Hex | null;
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
  addFill(f: StoredFill): Promise<void>;
  listFills(): Promise<StoredFill[]>;
  /** Ignores a statement already stored (same desk + seq). */
  addStatement(s: StoredStatement): Promise<void>;
  listStatements(): Promise<StoredStatement[]>;
  addSettleOut(s: StoredSettleOut): Promise<void>;
  updateSettleOut(requestId: Hex, patch: Partial<Pick<StoredSettleOut, "status" | "txHash">>): Promise<void>;
  listSettleOuts(): Promise<StoredSettleOut[]>;
}

export interface HushStoreData {
  payments: StoredPayment[];
  vouchers: StoredVoucher[];
  receipts: StoredReceipt[];
  refunds: StoredRefund[];
  fills: StoredFill[];
  statements: StoredStatement[];
  settleOuts: StoredSettleOut[];
}

export const emptyStoreData = (): HushStoreData => ({
  payments: [],
  vouchers: [],
  receipts: [],
  refunds: [],
  fills: [],
  statements: [],
  settleOuts: [],
});

export class MemoryHushStore implements HushStore {
  protected data: HushStoreData;

  constructor(initial?: Partial<HushStoreData>) {
    // Files written before v2 lack the trading arrays.
    this.data = { ...emptyStoreData(), ...initial };
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
  async addFill(f: StoredFill) {
    this.data.fills.push(f);
    await this.persist();
  }
  async listFills() {
    return [...this.data.fills];
  }
  async addStatement(s: StoredStatement) {
    const dup = this.data.statements.some(
      (x) => x.desk.toLowerCase() === s.desk.toLowerCase() && x.statement.seq === s.statement.seq && x.statement.agent.toLowerCase() === s.statement.agent.toLowerCase(),
    );
    if (dup) return;
    this.data.statements.push(s);
    await this.persist();
  }
  async listStatements() {
    return [...this.data.statements];
  }
  async addSettleOut(s: StoredSettleOut) {
    this.data.settleOuts.push(s);
    await this.persist();
  }
  async updateSettleOut(requestId: Hex, patch: Partial<Pick<StoredSettleOut, "status" | "txHash">>) {
    const s = this.data.settleOuts.find((x) => x.request.requestId.toLowerCase() === requestId.toLowerCase());
    if (s) Object.assign(s, patch);
    await this.persist();
  }
  async listSettleOuts() {
    return [...this.data.settleOuts];
  }
}
