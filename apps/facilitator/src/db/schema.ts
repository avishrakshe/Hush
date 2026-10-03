import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Amounts are USDC atomic units stored as decimal TEXT (bigint-safe). Timestamps are unix ms.

export const credits = sqliteTable(
  "credits",
  {
    agent: text("agent").notNull(),
    provider: text("provider").notNull(),
    creditedTotal: text("credited_total").notNull(),
    refundedTotal: text("refunded_total").notNull(),
    settledCumulative: text("settled_cumulative").notNull(),
    /** v2: sale proceeds the desk credited back (0 for API providers). */
    proceedsTotal: text("proceeds_total").notNull().default("0"),
    lastNonce: text("last_nonce").notNull(),
    lastTopUpAt: integer("last_top_up_at"),
  },
  (t) => [primaryKey({ columns: [t.agent, t.provider] })],
);

export const topUps = sqliteTable("top_ups", {
  txHash: text("tx_hash").primaryKey(),
  agent: text("agent").notNull(),
  provider: text("provider").notNull(),
  payer: text("payer").notNull(),
  amount: text("amount").notNull(),
  blockNumber: text("block_number").notNull(),
  receipt: text("receipt", { mode: "json" }).notNull(),
  signature: text("signature").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const vouchers = sqliteTable("vouchers", {
  leaf: text("leaf").primaryKey(),
  agent: text("agent").notNull(),
  provider: text("provider").notNull(),
  voucher: text("voucher", { mode: "json" }).notNull(),
  signature: text("signature").notNull(),
  amount: text("amount").notNull(),
  resource: text("resource").notNull(),
  settledAt: integer("settled_at").notNull(),
  batchId: text("batch_id"),
  proof: text("proof", { mode: "json" }),
});

export const batches = sqliteTable(
  "batches",
  {
    provider: text("provider").notNull(),
    batchId: text("batch_id").notNull(),
    root: text("root").notNull(),
    txHash: text("tx_hash").notNull(),
    voucherCount: integer("voucher_count").notNull(),
    dummy: integer("dummy", { mode: "boolean" }).notNull(),
    committedAt: integer("committed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.batchId] })],
);

export const refunds = sqliteTable("refunds", {
  id: text("id").primaryKey(),
  agent: text("agent").notNull(),
  provider: text("provider").notNull(),
  amount: text("amount").notNull(),
  txHash: text("tx_hash"),
  reason: text("reason", { enum: ["requested", "expired"] }).notNull(),
  status: text("status", { enum: ["sent", "failed"] }).notNull(),
  createdAt: integer("created_at").notNull(),
});

export const directPayments = sqliteTable("direct_payments", {
  txHash: text("tx_hash").primaryKey(),
  agent: text("agent").notNull(),
  provider: text("provider").notNull(),
  amount: text("amount").notNull(),
  resource: text("resource").notNull(),
  settledAt: integer("settled_at").notNull(),
});

// ─── v2: Hush Desk (only the desk's facilitator writes these). Sizes in 0.01-share units, prices USDC atomic. ───

/** Quotes that were filled — the replay guard (insert-if-absent). */
export const deskQuotes = sqliteTable("desk_quotes", {
  quoteId: text("quote_id").primaryKey(),
  agent: text("agent").notNull(),
  usedAt: integer("used_at").notNull(),
});

export const deskFills = sqliteTable("desk_fills", {
  quoteId: text("quote_id").primaryKey(),
  agent: text("agent").notNull(),
  ticker: text("ticker").notNull(),
  side: text("side", { enum: ["buy", "sell"] }).notNull(),
  size: text("size").notNull(),
  price: text("price").notNull(),
  notional: text("notional").notNull(),
  scheme: text("scheme", { enum: ["hush-rfq", "exact"] }).notNull(),
  filledAt: integer("filled_at").notNull(),
  fill: text("fill", { mode: "json" }).notNull(),
  signature: text("signature").notNull(),
  voucherLeaf: text("voucher_leaf"),
  paymentTx: text("payment_tx"),
  deliveryTx: text("delivery_tx"),
});

/** Every signed custody statement (seq strictly increasing per agent). */
export const deskStatements = sqliteTable(
  "desk_statements",
  {
    agent: text("agent").notNull(),
    seq: integer("seq").notNull(),
    ticker: text("ticker").notNull(),
    position: text("position").notNull(),
    avgCost: text("avg_cost").notNull(),
    reason: text("reason", { enum: ["buy", "sell", "settle-out", "settle-out-reversed"] }).notNull(),
    statement: text("statement", { mode: "json" }).notNull(),
    signature: text("signature").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.agent, t.seq] })],
);

/** Current custody per (agent, ticker) = the latest statement. */
export const deskPositions = sqliteTable(
  "desk_positions",
  {
    agent: text("agent").notNull(),
    ticker: text("ticker").notNull(),
    position: text("position").notNull(),
    avgCost: text("avg_cost").notNull(),
    seq: integer("seq").notNull(),
  },
  (t) => [primaryKey({ columns: [t.agent, t.ticker] })],
);

export const deskSettleOuts = sqliteTable("desk_settle_outs", {
  requestId: text("request_id").primaryKey(),
  agent: text("agent").notNull(),
  ticker: text("ticker").notNull(),
  size: text("size").notNull(),
  avgCost: text("avg_cost").notNull(),
  status: text("status", { enum: ["queued", "sent", "failed"] }).notNull(),
  txHash: text("tx_hash"),
  request: text("request", { mode: "json" }).notNull(),
  signature: text("signature").notNull(),
  createdAt: integer("created_at").notNull(),
  executedAt: integer("executed_at"),
  error: text("error"),
});

/** Public `exact` (EIP-3009) settlements — the visible baseline shown on the demo. */
export const exactPayments = sqliteTable("exact_payments", {
  txHash: text("tx_hash").primaryKey(),
  payer: text("payer").notNull(),
  payTo: text("pay_to").notNull(),
  amount: text("amount").notNull(),
  resource: text("resource").notNull(),
  settledAt: integer("settled_at").notNull(),
});
