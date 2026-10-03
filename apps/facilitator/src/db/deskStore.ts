import type { FillReceiptJson, PositionStatementJson, SettleOutRequestJson, StockTicker } from "@hush/x402";
import type { DeskStore, FillRecord, PositionRecord, SettleOutRecord, StatementRecord } from "@hush/x402/facilitator";
import { and, desc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { type Address, type Hex, getAddress } from "viem";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;
const lc = (a: string) => a.toLowerCase();

/** SQLite-backed DeskStore (the Hush Desk's custody ledger). Shares the facilitator's database file. */
export class SqliteDeskStore implements DeskStore {
  constructor(readonly db: Db) {}

  async useQuote(quoteId: Hex, agent: Address, at: number) {
    // Insert-if-absent: the primary key makes a second fill of the same quote impossible.
    const r = this.db.insert(schema.deskQuotes).values({ quoteId: lc(quoteId), agent: lc(agent), usedAt: at }).onConflictDoNothing().run();
    return r.changes === 1;
  }

  async isQuoteUsed(quoteId: Hex) {
    return !!this.db.select({ q: schema.deskQuotes.quoteId }).from(schema.deskQuotes).where(eq(schema.deskQuotes.quoteId, lc(quoteId))).get();
  }

  async addFill(f: FillRecord) {
    this.db
      .insert(schema.deskFills)
      .values({
        quoteId: lc(f.quoteId),
        agent: lc(f.agent),
        ticker: f.ticker,
        side: f.side,
        size: f.size.toString(),
        price: f.price.toString(),
        notional: f.notional.toString(),
        scheme: f.scheme,
        filledAt: f.filledAt,
        fill: f.fill,
        signature: f.signature,
        voucherLeaf: f.voucherLeaf,
        paymentTx: f.paymentTx,
        deliveryTx: f.deliveryTx,
      })
      .run();
  }

  async listFills(f?: { agent?: Address; limit?: number }): Promise<FillRecord[]> {
    const q = this.db.select().from(schema.deskFills);
    return (f?.agent ? q.where(eq(schema.deskFills.agent, lc(f.agent))) : q)
      .orderBy(desc(schema.deskFills.filledAt))
      .limit(f?.limit ?? 500)
      .all()
      .map((r) => ({
        quoteId: r.quoteId as Hex,
        agent: getAddress(r.agent),
        ticker: r.ticker as StockTicker,
        side: r.side,
        size: BigInt(r.size),
        price: BigInt(r.price),
        notional: BigInt(r.notional),
        scheme: r.scheme,
        filledAt: r.filledAt,
        fill: r.fill as FillReceiptJson,
        signature: r.signature as Hex,
        voucherLeaf: r.voucherLeaf as Hex | null,
        paymentTx: r.paymentTx as Hex | null,
        deliveryTx: r.deliveryTx as Hex | null,
      }));
  }

  async getPosition(agent: Address, ticker: StockTicker): Promise<PositionRecord> {
    const r = this.db
      .select()
      .from(schema.deskPositions)
      .where(and(eq(schema.deskPositions.agent, lc(agent)), eq(schema.deskPositions.ticker, ticker)))
      .get();
    return r
      ? { agent: getAddress(r.agent), ticker, position: BigInt(r.position), avgCost: BigInt(r.avgCost), seq: BigInt(r.seq) }
      : { agent, ticker, position: 0n, avgCost: 0n, seq: 0n };
  }

  async listPositions(agent?: Address): Promise<PositionRecord[]> {
    const q = this.db.select().from(schema.deskPositions);
    return (agent ? q.where(eq(schema.deskPositions.agent, lc(agent))) : q).all().map((r) => ({
      agent: getAddress(r.agent),
      ticker: r.ticker as StockTicker,
      position: BigInt(r.position),
      avgCost: BigInt(r.avgCost),
      seq: BigInt(r.seq),
    }));
  }

  async lastSeq(agent: Address) {
    const r = this.db.select({ m: sql<number | null>`max(${schema.deskStatements.seq})` }).from(schema.deskStatements).where(eq(schema.deskStatements.agent, lc(agent))).get();
    return BigInt(r?.m ?? 0);
  }

  async addStatement(s: StatementRecord) {
    this.db.transaction((tx) => {
      tx.insert(schema.deskStatements)
        .values({
          agent: lc(s.agent),
          seq: Number(s.seq),
          ticker: s.ticker,
          position: s.position.toString(),
          avgCost: s.avgCost.toString(),
          reason: s.reason,
          statement: s.statement,
          signature: s.signature,
          issuedAt: s.issuedAt,
        })
        .run();
      const position = { agent: lc(s.agent), ticker: s.ticker, position: s.position.toString(), avgCost: s.avgCost.toString(), seq: Number(s.seq) };
      tx.insert(schema.deskPositions)
        .values(position)
        .onConflictDoUpdate({ target: [schema.deskPositions.agent, schema.deskPositions.ticker], set: position })
        .run();
    });
  }

  async listStatements(agent: Address, limit = 500): Promise<StatementRecord[]> {
    return this.db
      .select()
      .from(schema.deskStatements)
      .where(eq(schema.deskStatements.agent, lc(agent)))
      .orderBy(desc(schema.deskStatements.seq))
      .limit(limit)
      .all()
      .map((r) => ({
        agent: getAddress(r.agent),
        seq: BigInt(r.seq),
        ticker: r.ticker as StockTicker,
        position: BigInt(r.position),
        avgCost: BigInt(r.avgCost),
        reason: r.reason,
        statement: r.statement as PositionStatementJson,
        signature: r.signature as Hex,
        issuedAt: r.issuedAt,
      }));
  }

  async addSettleOut(r: SettleOutRecord) {
    this.db
      .insert(schema.deskSettleOuts)
      .values({
        requestId: lc(r.requestId),
        agent: lc(r.agent),
        ticker: r.ticker,
        size: r.size.toString(),
        avgCost: r.avgCost.toString(),
        status: r.status,
        txHash: r.txHash,
        request: r.request,
        signature: r.signature,
        createdAt: r.createdAt,
        executedAt: r.executedAt,
        error: r.error,
      })
      .run();
  }

  async hasSettleOut(requestId: Hex) {
    return !!this.db
      .select({ id: schema.deskSettleOuts.requestId })
      .from(schema.deskSettleOuts)
      .where(eq(schema.deskSettleOuts.requestId, lc(requestId)))
      .get();
  }

  async updateSettleOut(requestId: Hex, patch: Partial<Pick<SettleOutRecord, "status" | "txHash" | "executedAt" | "error">>) {
    this.db.update(schema.deskSettleOuts).set(patch).where(eq(schema.deskSettleOuts.requestId, lc(requestId))).run();
  }

  async listSettleOuts(f?: { agent?: Address; status?: SettleOutRecord["status"]; limit?: number }): Promise<SettleOutRecord[]> {
    const conds = [
      ...(f?.agent ? [eq(schema.deskSettleOuts.agent, lc(f.agent))] : []),
      ...(f?.status ? [eq(schema.deskSettleOuts.status, f.status)] : []),
    ];
    const q = this.db.select().from(schema.deskSettleOuts);
    return (conds.length ? q.where(and(...conds)) : q)
      .orderBy(schema.deskSettleOuts.createdAt)
      .limit(f?.limit ?? 500)
      .all()
      .map((r) => ({
        requestId: r.requestId as Hex,
        agent: getAddress(r.agent),
        ticker: r.ticker as StockTicker,
        size: BigInt(r.size),
        avgCost: BigInt(r.avgCost),
        status: r.status,
        txHash: r.txHash as Hex | null,
        request: r.request as SettleOutRequestJson,
        signature: r.signature as Hex,
        createdAt: r.createdAt,
        executedAt: r.executedAt,
        error: r.error,
      }));
  }
}
