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

/** Public `exact` (EIP-3009) settlements — the visible baseline shown on the demo. */
export const exactPayments = sqliteTable("exact_payments", {
  txHash: text("tx_hash").primaryKey(),
  payer: text("payer").notNull(),
  payTo: text("pay_to").notNull(),
  amount: text("amount").notNull(),
  resource: text("resource").notNull(),
  settledAt: integer("settled_at").notNull(),
});
