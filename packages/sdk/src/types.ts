import type { Address, Hex } from "viem";
import type { StockTicker } from "./constants.js";

/** Addresses of one Hush deployment (eERC converter stack + Hush contracts). */
export interface HushContracts {
  chainId: number;
  /** eERC token decimals (2 on the reference deployment → 0.01 hUSDC granularity). */
  eercDecimals: number;
  /** Block the eERC contract was deployed in — lower bound for log scans. */
  startBlock: number;
  encryptedErc: Address;
  registrar: Address;
  /** The ERC-20 wrapped by the eERC converter (MockUSDC or Circle USDC). */
  usdc: Address;
  hushRegistry: Address;
  hushLedger: Address;
  /** v2: MockStockOracle (absent on deployments without the stock contracts). */
  stockOracle?: Address;
  /** v2: mock stock token per ticker. The same eERC converter wraps them (tokenIds assigned on first deposit). */
  stocks?: Partial<Record<StockTicker, Address>>;
}

/**
 * Signed by the agent for every hush-credit call. `cumulativeSpent` is a running total in USDC atomic units
 * (6 dp), so a newer voucher supersedes older ones — the model x402's batch-settlement scheme uses.
 */
export interface Voucher {
  agent: Address;
  provider: Address;
  cumulativeSpent: bigint;
  nonce: bigint;
  requestHash: Hex;
  expiry: bigint;
}

export interface SignedVoucher {
  voucher: Voucher;
  signature: Hex;
}

/** Signed by the provider when it credits a private top-up. Makes the provider accountable for the top-up. */
export interface CreditReceipt {
  agent: Address;
  provider: Address;
  creditedTotal: bigint;
  topupTxHash: Hex;
  issuedAt: bigint;
}

export interface SignedCreditReceipt {
  receipt: CreditReceipt;
  signature: Hex;
}

/** Agent-signed request for the provider to privately return unspent credit. */
export interface RefundRequest {
  agent: Address;
  provider: Address;
  deadline: bigint;
}

/** Signed by the agent (or its owner) to read the agent's credit from a facilitator. */
export interface CreditQuery {
  agent: Address;
  provider: Address;
  /** Unix seconds; the facilitator accepts it for CREDIT_QUERY_MAX_AGE_SECONDS. */
  issuedAt: bigint;
}

// ─── JSON wire forms (bigints as decimal strings) ───

export interface VoucherJson {
  agent: Address;
  provider: Address;
  cumulativeSpent: string;
  nonce: string;
  requestHash: Hex;
  expiry: string;
}

export interface CreditReceiptJson {
  agent: Address;
  provider: Address;
  creditedTotal: string;
  topupTxHash: Hex;
  issuedAt: string;
}

export interface RefundRequestJson {
  agent: Address;
  provider: Address;
  deadline: string;
}

/** `PaymentRequirements.extra` advertised for the hush-credit scheme. */
export interface HushCreditExtra {
  /** Where agents send top-ups (`POST /topup`), sync credit and fetch Merkle proofs. */
  facilitatorUrl: string;
  encryptedErc: Address;
  hushLedger: Address;
  hushRegistry: Address;
  eercDecimals: number;
  /** Smallest accepted top-up, USDC atomic units. */
  minTopUp: string;
  /** Unused credit is refunded automatically this long after the last top-up. */
  creditTtlSeconds: number;
}

/** `PaymentPayload.payload` for hush-credit. */
export interface HushCreditPayload {
  voucher: VoucherJson;
  signature: Hex;
}

/** `PaymentRequirements.extra` for hush-direct (reference scheme: one eERC transfer per call). */
export interface HushDirectExtra {
  encryptedErc: Address;
  eercDecimals: number;
}

/** `PaymentPayload.payload` for hush-direct. */
export interface HushDirectPayload {
  txHash: Hex;
}

/** Credit state for one (agent, provider) pair as reported by the facilitator. All amounts USDC atomic units. */
export interface CreditStateJson {
  agent: Address;
  provider: Address;
  creditedTotal: string;
  refundedTotal: string;
  settledCumulative: string;
  available: string;
  lastNonce: string;
  lastTopUpAt: number | null;
  expiresAt: number | null;
  frozen: boolean;
}

export interface TopUpResponse {
  receipt: CreditReceiptJson;
  signature: Hex;
  credit: CreditStateJson;
  /** hUSDC credited by this top-up, USDC atomic units. */
  amount: string;
  /** Account that paid (the agent itself, or its owner's treasury). */
  payer: Address;
}

export interface RefundResponse {
  txHash: Hex | null;
  /** USDC atomic units returned (0 when nothing was refundable). */
  amount: string;
  credit: CreditStateJson;
}

export interface VoucherProofJson {
  leaf: Hex;
  provider: Address;
  batchId: string;
  root: Hex;
  proof: Hex[];
  commitTx: Hex | null;
}
