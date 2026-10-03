import type { Address, Hex } from "viem";
import type { StockTicker } from "../constants.js";
import type { FillReceiptJson, PositionStatementJson, SettleOutRequestJson } from "../types.js";

/** A filled quote. Sizes in 0.01-share units, prices/notional in USDC atomic. */
export interface FillRecord {
  quoteId: Hex;
  agent: Address;
  ticker: StockTicker;
  side: "buy" | "sell";
  size: bigint;
  price: bigint;
  notional: bigint;
  /** hush-rfq = custodied (private); exact = public payment + public token delivery. */
  scheme: "hush-rfq" | "exact";
  filledAt: number;
  fill: FillReceiptJson;
  signature: Hex;
  /** hush-rfq: the voucher leaf that paid (buy) or ordered (sell) it — committed in the next HushLedger batch. */
  voucherLeaf: Hex | null;
  /** exact: the EIP-3009 payment and the public token delivery. */
  paymentTx: Hex | null;
  deliveryTx: Hex | null;
}

/** Current custody for one (agent, ticker), as of statement `seq`. */
export interface PositionRecord {
  agent: Address;
  ticker: StockTicker;
  position: bigint;
  avgCost: bigint;
  seq: bigint;
}

export type StatementReason = "buy" | "sell" | "settle-out" | "settle-out-reversed";

export interface StatementRecord {
  agent: Address;
  seq: bigint;
  ticker: StockTicker;
  position: bigint;
  avgCost: bigint;
  reason: StatementReason;
  statement: PositionStatementJson;
  signature: Hex;
  issuedAt: number;
}

export interface SettleOutRecord {
  requestId: Hex;
  agent: Address;
  ticker: StockTicker;
  size: bigint;
  /** Average cost when the shares left custody (restored if the transfer fails). */
  avgCost: bigint;
  status: "queued" | "sent" | "failed";
  txHash: Hex | null;
  request: SettleOutRequestJson;
  signature: Hex;
  createdAt: number;
  executedAt: number | null;
  error: string | null;
}

/**
 * Desk persistence (quotes consumed, fills, signed position statements, settle-outs). The desk serializes bookings,
 * so implementations only need atomic single operations — except `useQuote`, which must be an atomic insert-if-absent.
 */
export interface DeskStore {
  /** Marks a quote consumed. Returns false if it already was (replay). */
  useQuote(quoteId: Hex, agent: Address, at: number): Promise<boolean>;
  isQuoteUsed(quoteId: Hex): Promise<boolean>;

  addFill(f: FillRecord): Promise<void>;
  listFills(filter?: { agent?: Address; limit?: number }): Promise<FillRecord[]>;

  getPosition(agent: Address, ticker: StockTicker): Promise<PositionRecord>;
  listPositions(agent?: Address): Promise<PositionRecord[]>;
  lastSeq(agent: Address): Promise<bigint>;
  /** Stores a statement and makes it the current position for (agent, ticker), atomically. */
  addStatement(s: StatementRecord): Promise<void>;
  listStatements(agent: Address, limit?: number): Promise<StatementRecord[]>;

  addSettleOut(r: SettleOutRecord): Promise<void>;
  hasSettleOut(requestId: Hex): Promise<boolean>;
  updateSettleOut(requestId: Hex, patch: Partial<Pick<SettleOutRecord, "status" | "txHash" | "executedAt" | "error">>): Promise<void>;
  listSettleOuts(filter?: { agent?: Address; status?: SettleOutRecord["status"]; limit?: number }): Promise<SettleOutRecord[]>;
}

const k = (...parts: string[]) => parts.map((p) => p.toLowerCase()).join(":");

export class MemoryDeskStore implements DeskStore {
  private quotes = new Set<string>();
  private fills: FillRecord[] = [];
  private positions = new Map<string, PositionRecord>();
  private statements: StatementRecord[] = [];
  private settleOuts = new Map<string, SettleOutRecord>();

  async useQuote(quoteId: Hex) {
    if (this.quotes.has(quoteId.toLowerCase())) return false;
    this.quotes.add(quoteId.toLowerCase());
    return true;
  }
  async isQuoteUsed(quoteId: Hex) {
    return this.quotes.has(quoteId.toLowerCase());
  }
  async addFill(f: FillRecord) {
    this.fills.push(f);
  }
  async listFills(f?: { agent?: Address; limit?: number }) {
    return this.fills
      .filter((x) => !f?.agent || x.agent.toLowerCase() === f.agent.toLowerCase())
      .sort((a, b) => b.filledAt - a.filledAt)
      .slice(0, f?.limit ?? Number.POSITIVE_INFINITY);
  }
  async getPosition(agent: Address, ticker: StockTicker) {
    return { ...(this.positions.get(k(agent, ticker)) ?? { agent, ticker, position: 0n, avgCost: 0n, seq: 0n }) };
  }
  async listPositions(agent?: Address) {
    return [...this.positions.values()].filter((p) => !agent || p.agent.toLowerCase() === agent.toLowerCase()).map((p) => ({ ...p }));
  }
  async lastSeq(agent: Address) {
    return this.statements.filter((s) => s.agent.toLowerCase() === agent.toLowerCase()).reduce((m, s) => (s.seq > m ? s.seq : m), 0n);
  }
  async addStatement(s: StatementRecord) {
    this.statements.push(s);
    this.positions.set(k(s.agent, s.ticker), { agent: s.agent, ticker: s.ticker, position: s.position, avgCost: s.avgCost, seq: s.seq });
  }
  async listStatements(agent: Address, limit = 500) {
    return this.statements
      .filter((s) => s.agent.toLowerCase() === agent.toLowerCase())
      .sort((a, b) => (a.seq > b.seq ? -1 : 1))
      .slice(0, limit);
  }
  async addSettleOut(r: SettleOutRecord) {
    this.settleOuts.set(r.requestId.toLowerCase(), { ...r });
  }
  async hasSettleOut(requestId: Hex) {
    return this.settleOuts.has(requestId.toLowerCase());
  }
  async updateSettleOut(requestId: Hex, patch: Partial<SettleOutRecord>) {
    const r = this.settleOuts.get(requestId.toLowerCase());
    if (r) Object.assign(r, patch);
  }
  async listSettleOuts(f?: { agent?: Address; status?: SettleOutRecord["status"]; limit?: number }) {
    return [...this.settleOuts.values()]
      .filter((r) => (!f?.agent || r.agent.toLowerCase() === f.agent.toLowerCase()) && (!f?.status || r.status === f.status))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, f?.limit ?? Number.POSITIVE_INFINITY)
      .map((r) => ({ ...r }));
  }
}
