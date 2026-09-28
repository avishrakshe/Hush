import type {
  BatchRecord,
  CreditRecord,
  CreditStore,
  DirectPaymentRecord,
  RefundRecord,
  SettledVoucherRecord,
  TopUpRecord,
} from "@hush/x402/facilitator";
import type { CreditReceiptJson, VoucherJson } from "@hush/x402";
import Database from "better-sqlite3";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, getAddress } from "viem";
import * as schema from "./schema.js";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function openDb(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

type Db = BetterSQLite3Database<typeof schema>;
const lc = (a: string) => a.toLowerCase();

/** SQLite-backed CreditStore. Addresses are stored lower-cased so lookups are case-insensitive. */
export class SqliteCreditStore implements CreditStore {
  constructor(readonly db: Db) {}

  async getCredit(agent: Address, provider: Address): Promise<CreditRecord> {
    const row = this.db
      .select()
      .from(schema.credits)
      .where(and(eq(schema.credits.agent, lc(agent)), eq(schema.credits.provider, lc(provider))))
      .get();
    return {
      agent,
      provider,
      creditedTotal: BigInt(row?.creditedTotal ?? 0),
      refundedTotal: BigInt(row?.refundedTotal ?? 0),
      settledCumulative: BigInt(row?.settledCumulative ?? 0),
      lastNonce: BigInt(row?.lastNonce ?? 0),
      lastTopUpAt: row?.lastTopUpAt ?? null,
    };
  }

  async putCredit(r: CreditRecord) {
    const values = {
      agent: lc(r.agent),
      provider: lc(r.provider),
      creditedTotal: r.creditedTotal.toString(),
      refundedTotal: r.refundedTotal.toString(),
      settledCumulative: r.settledCumulative.toString(),
      lastNonce: r.lastNonce.toString(),
      lastTopUpAt: r.lastTopUpAt,
    };
    this.db
      .insert(schema.credits)
      .values(values)
      .onConflictDoUpdate({ target: [schema.credits.agent, schema.credits.provider], set: values })
      .run();
  }

  async listCredits(provider: Address): Promise<CreditRecord[]> {
    return this.db
      .select()
      .from(schema.credits)
      .where(eq(schema.credits.provider, lc(provider)))
      .all()
      .map((row) => ({
        agent: getAddress(row.agent),
        provider: getAddress(row.provider),
        creditedTotal: BigInt(row.creditedTotal),
        refundedTotal: BigInt(row.refundedTotal),
        settledCumulative: BigInt(row.settledCumulative),
        lastNonce: BigInt(row.lastNonce),
        lastTopUpAt: row.lastTopUpAt,
      }));
  }

  async hasTopUp(txHash: Hex) {
    return !!this.db.select({ t: schema.topUps.txHash }).from(schema.topUps).where(eq(schema.topUps.txHash, lc(txHash))).get();
  }

  async addTopUp(t: TopUpRecord) {
    this.db
      .insert(schema.topUps)
      .values({
        txHash: lc(t.txHash),
        agent: lc(t.agent),
        provider: lc(t.provider),
        payer: lc(t.payer),
        amount: t.amount.toString(),
        blockNumber: t.blockNumber.toString(),
        receipt: t.receipt,
        signature: t.signature,
        createdAt: t.createdAt,
      })
      .run();
  }

  async listTopUps(f?: { agent?: Address; limit?: number }): Promise<TopUpRecord[]> {
    const q = this.db.select().from(schema.topUps);
    const rows = (f?.agent ? q.where(eq(schema.topUps.agent, lc(f.agent))) : q)
      .orderBy(desc(schema.topUps.createdAt))
      .limit(f?.limit ?? 500)
      .all();
    return rows.map((r) => ({
      txHash: r.txHash as Hex,
      agent: getAddress(r.agent),
      provider: getAddress(r.provider),
      payer: getAddress(r.payer),
      amount: BigInt(r.amount),
      blockNumber: BigInt(r.blockNumber),
      receipt: r.receipt as CreditReceiptJson,
      signature: r.signature as Hex,
      createdAt: r.createdAt,
    }));
  }

  async addSettledVoucher(v: SettledVoucherRecord) {
    this.db
      .insert(schema.vouchers)
      .values({
        leaf: lc(v.leaf),
        agent: lc(v.agent),
        provider: lc(v.provider),
        voucher: v.voucher,
        signature: v.signature,
        amount: v.amount.toString(),
        resource: v.resource,
        settledAt: v.settledAt,
        batchId: v.batchId?.toString() ?? null,
        proof: v.proof,
      })
      .run();
  }

  private toVoucher(r: typeof schema.vouchers.$inferSelect): SettledVoucherRecord {
    return {
      leaf: r.leaf as Hex,
      agent: getAddress(r.agent),
      provider: getAddress(r.provider),
      voucher: r.voucher as VoucherJson,
      signature: r.signature as Hex,
      amount: BigInt(r.amount),
      resource: r.resource,
      settledAt: r.settledAt,
      batchId: r.batchId === null ? null : BigInt(r.batchId),
      proof: (r.proof as Hex[] | null) ?? null,
    };
  }

  async listUnbatchedVouchers(provider: Address) {
    return this.db
      .select()
      .from(schema.vouchers)
      .where(and(eq(schema.vouchers.provider, lc(provider)), isNull(schema.vouchers.batchId)))
      .all()
      .map((r) => this.toVoucher(r));
  }

  async getVoucher(leaf: Hex) {
    const r = this.db.select().from(schema.vouchers).where(eq(schema.vouchers.leaf, lc(leaf))).get();
    return r ? this.toVoucher(r) : undefined;
  }

  async listVouchers(f?: { agent?: Address; limit?: number }) {
    const q = this.db.select().from(schema.vouchers);
    return (f?.agent ? q.where(eq(schema.vouchers.agent, lc(f.agent))) : q)
      .orderBy(desc(schema.vouchers.settledAt))
      .limit(f?.limit ?? 500)
      .all()
      .map((r) => this.toVoucher(r));
  }

  async addBatch(b: BatchRecord, proofs: Map<string, Hex[]>) {
    this.db.transaction((tx) => {
      tx.insert(schema.batches)
        .values({
          provider: lc(b.provider),
          batchId: b.batchId.toString(),
          root: b.root,
          txHash: b.txHash,
          voucherCount: b.voucherCount,
          dummy: b.dummy,
          committedAt: b.committedAt,
        })
        .run();
      for (const [leaf, proof] of proofs) {
        tx.update(schema.vouchers).set({ batchId: b.batchId.toString(), proof }).where(eq(schema.vouchers.leaf, lc(leaf))).run();
      }
    });
  }

  private toBatch(r: typeof schema.batches.$inferSelect): BatchRecord {
    return {
      provider: getAddress(r.provider),
      batchId: BigInt(r.batchId),
      root: r.root as Hex,
      txHash: r.txHash as Hex,
      voucherCount: r.voucherCount,
      dummy: r.dummy,
      committedAt: r.committedAt,
    };
  }

  async getBatch(provider: Address, batchId: bigint) {
    const r = this.db
      .select()
      .from(schema.batches)
      .where(and(eq(schema.batches.provider, lc(provider)), eq(schema.batches.batchId, batchId.toString())))
      .get();
    return r ? this.toBatch(r) : undefined;
  }

  async listBatches(provider: Address, limit = 50) {
    return this.db
      .select()
      .from(schema.batches)
      .where(eq(schema.batches.provider, lc(provider)))
      .orderBy(desc(schema.batches.committedAt))
      .limit(limit)
      .all()
      .map((r) => this.toBatch(r));
  }

  async addRefund(r: RefundRecord) {
    this.db
      .insert(schema.refunds)
      .values({ ...r, agent: lc(r.agent), provider: lc(r.provider), amount: r.amount.toString(), txHash: r.txHash })
      .run();
  }

  async listRefunds(f?: { agent?: Address; limit?: number }): Promise<RefundRecord[]> {
    const q = this.db.select().from(schema.refunds);
    return (f?.agent ? q.where(eq(schema.refunds.agent, lc(f.agent))) : q)
      .orderBy(desc(schema.refunds.createdAt))
      .limit(f?.limit ?? 500)
      .all()
      .map((r) => ({ ...r, agent: getAddress(r.agent), provider: getAddress(r.provider), amount: BigInt(r.amount), txHash: r.txHash as Hex | null }));
  }

  async hasDirectPayment(txHash: Hex) {
    return !!this.db.select({ t: schema.directPayments.txHash }).from(schema.directPayments).where(eq(schema.directPayments.txHash, lc(txHash))).get();
  }

  async addDirectPayment(p: DirectPaymentRecord) {
    this.db
      .insert(schema.directPayments)
      .values({ ...p, txHash: lc(p.txHash), agent: lc(p.agent), provider: lc(p.provider), amount: p.amount.toString() })
      .run();
  }

  // ─── facilitator-app extras (not part of CreditStore) ───

  addExactPayment(p: { txHash: string; payer: string; payTo: string; amount: string; resource: string; settledAt: number }) {
    this.db.insert(schema.exactPayments).values({ ...p, txHash: lc(p.txHash) }).onConflictDoNothing().run();
  }

  listExactPayments(limit = 200) {
    return this.db.select().from(schema.exactPayments).orderBy(desc(schema.exactPayments.settledAt)).limit(limit).all();
  }

  /** Counters for the public PROOF section — counts only, never amounts. */
  stats(provider: Address) {
    const count = (table: typeof schema.topUps | typeof schema.batches | typeof schema.refunds) =>
      this.db.select({ n: sql<number>`count(*)` }).from(table).get()?.n ?? 0;
    return {
      provider,
      privateTopUps: count(schema.topUps),
      batchesCommitted: count(schema.batches),
      privateRefunds: count(schema.refunds),
    };
  }
}
