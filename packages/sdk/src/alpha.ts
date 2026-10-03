/**
 * v2 typed data under the HushAlpha EIP-712 domain: desk quotes, fill receipts, position statements, signal records
 * (all checkable on-chain via HushAlpha.isValid*Signature) and agent settle-out requests (off-chain only).
 */
import { type Address, type Hex, type TypedDataDomain, hashTypedData, isAddressEqual, recoverTypedDataAddress } from "viem";
import {
  ALPHA_EIP712_NAME,
  ALPHA_EIP712_VERSION,
  FILL_RECEIPT_TYPES,
  POSITION_STATEMENT_TYPES,
  QUOTE_TYPES,
  SETTLE_OUT_TYPES,
  SIGNAL_RECORD_TYPES,
} from "./constants.js";
import type { TypedDataSigner } from "./eip712.js";
import type {
  FillReceipt,
  FillReceiptJson,
  PositionStatement,
  PositionStatementJson,
  Quote,
  QuoteJson,
  SettleOutRequest,
  SettleOutRequestJson,
  SignalRecord,
  SignalRecordJson,
} from "./types.js";

/** HushAlpha EIP-712 domain: binds desk/signal signatures to one HushAlpha deployment on one chain. */
export function alphaDomain(chainId: number, hushAlpha: Address): TypedDataDomain {
  return { name: ALPHA_EIP712_NAME, version: ALPHA_EIP712_VERSION, chainId, verifyingContract: hushAlpha };
}

type Types = Record<string, readonly { name: string; type: string }[]>;

function typed<T extends object>(types: Types, primaryType: string, issuer: (value: T) => Address) {
  return {
    sign: (signer: TypedDataSigner, domain: TypedDataDomain, value: T): Promise<Hex> =>
      signer.signTypedData({ domain: { ...domain }, types, primaryType, message: { ...value } as Record<string, unknown> }),
    hash: (domain: TypedDataDomain, value: T): Hex =>
      hashTypedData({ domain, types, primaryType, message: value } as Parameters<typeof hashTypedData>[0]),
    recover: (domain: TypedDataDomain, value: T, signature: Hex): Promise<Address> =>
      recoverTypedDataAddress({ domain, types, primaryType, message: value, signature } as Parameters<typeof recoverTypedDataAddress>[0]),
    /** True only when signed by the party the record names (desk / provider / agent). */
    async isValid(domain: TypedDataDomain, value: T, signature: Hex): Promise<boolean> {
      try {
        const signer = await recoverTypedDataAddress({ domain, types, primaryType, message: value, signature } as Parameters<
          typeof recoverTypedDataAddress
        >[0]);
        return isAddressEqual(signer, issuer(value));
      } catch {
        return false;
      }
    },
  };
}

export const quoteTyped = typed<Quote>(QUOTE_TYPES, "Quote", (q) => q.desk);
export const fillTyped = typed<FillReceipt>(FILL_RECEIPT_TYPES, "FillReceipt", (f) => f.desk);
export const statementTyped = typed<PositionStatement>(POSITION_STATEMENT_TYPES, "PositionStatement", (s) => s.desk);
export const signalTyped = typed<SignalRecord>(SIGNAL_RECORD_TYPES, "SignalRecord", (r) => r.provider);
export const settleOutTyped = typed<SettleOutRequest>(SETTLE_OUT_TYPES, "SettleOutRequest", (r) => r.agent);

/** The value a hush-rfq voucher carries as `requestHash`: the quote's EIP-712 digest, binding payment to that quote. */
export const quoteRequestHash = (domain: TypedDataDomain, quote: Quote): Hex => quoteTyped.hash(domain, quote);

// ─── units ───

/** notional (USDC atomic) for `size` centishares at `price` USDC atomic per share. Exact when price is whole cents. */
export const quoteNotional = (size: bigint, price: bigint): bigint => (size * price) / 100n;

/** "0.10" / "10" / 0.1 shares → centishares. Throws on more than 2 decimals (eERC can't hold less than 0.01 share). */
export function parseShares(value: string | number): bigint {
  const s = typeof value === "number" ? value.toString() : value.trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`invalid share amount "${s}" (max 2 decimals, e.g. 0.10)`);
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
}

/** centishares → "0.10". */
export const formatShares = (centishares: bigint) => `${centishares / 100n}.${(centishares % 100n).toString().padStart(2, "0")}`;

// ─── JSON codecs ───

export const quoteToJson = (q: Quote): QuoteJson => ({
  ...q,
  size: q.size.toString(),
  price: q.price.toString(),
  notional: q.notional.toString(),
  expiry: q.expiry.toString(),
});
export const quoteFromJson = (q: QuoteJson): Quote => ({
  quoteId: q.quoteId,
  desk: q.desk,
  agent: q.agent,
  ticker: q.ticker,
  side: Number(q.side),
  size: BigInt(q.size),
  price: BigInt(q.price),
  notional: BigInt(q.notional),
  expiry: BigInt(q.expiry),
});

export const fillToJson = (f: FillReceipt): FillReceiptJson => ({ ...f, size: f.size.toString(), price: f.price.toString(), filledAt: f.filledAt.toString() });
export const fillFromJson = (f: FillReceiptJson): FillReceipt => ({
  quoteId: f.quoteId,
  desk: f.desk,
  agent: f.agent,
  ticker: f.ticker,
  side: Number(f.side),
  size: BigInt(f.size),
  price: BigInt(f.price),
  filledAt: BigInt(f.filledAt),
});

export const statementToJson = (s: PositionStatement): PositionStatementJson => ({
  ...s,
  position: s.position.toString(),
  avgCost: s.avgCost.toString(),
  seq: s.seq.toString(),
  issuedAt: s.issuedAt.toString(),
});
export const statementFromJson = (s: PositionStatementJson): PositionStatement => ({
  desk: s.desk,
  agent: s.agent,
  ticker: s.ticker,
  position: BigInt(s.position),
  avgCost: BigInt(s.avgCost),
  seq: BigInt(s.seq),
  issuedAt: BigInt(s.issuedAt),
});

export const signalToJson = (r: SignalRecord): SignalRecordJson => ({
  ...r,
  price: r.price.toString(),
  issuedAt: r.issuedAt.toString(),
  horizonSec: r.horizonSec.toString(),
});
export const signalFromJson = (r: SignalRecordJson): SignalRecord => ({
  provider: r.provider,
  ticker: r.ticker,
  direction: Number(r.direction),
  confidenceBps: Number(r.confidenceBps),
  price: BigInt(r.price),
  issuedAt: BigInt(r.issuedAt),
  horizonSec: BigInt(r.horizonSec),
});

export const settleOutToJson = (r: SettleOutRequest): SettleOutRequestJson => ({ ...r, size: r.size.toString(), deadline: r.deadline.toString() });
export const settleOutFromJson = (r: SettleOutRequestJson): SettleOutRequest => ({
  requestId: r.requestId,
  agent: r.agent,
  desk: r.desk,
  ticker: r.ticker,
  size: BigInt(r.size),
  deadline: BigInt(r.deadline),
});
