export const HUSH_CREDIT = "hush-credit" as const;
export const HUSH_DIRECT = "hush-direct" as const;
export const EXACT = "exact" as const;
export type HushMode = "public" | typeof HUSH_CREDIT | typeof HUSH_DIRECT;

/** Scheme name used on the wire for each client mode. `public` is standard x402 `exact`. */
export const MODE_SCHEME: Record<HushMode, string> = {
  public: EXACT,
  [HUSH_CREDIT]: HUSH_CREDIT,
  [HUSH_DIRECT]: HUSH_DIRECT,
};

export const USDC_DECIMALS = 6;
export const DEFAULT_CREDIT_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_VOUCHER_TTL_SECONDS = 5 * 60;

export const FUJI_CHAIN_ID = 43113;
export const AVALANCHE_CHAIN_ID = 43114;
export const toCaip2 = (chainId: number) => `eip155:${chainId}` as const;

/** EIP-712 domain name/version for vouchers, receipts and refund requests (verifyingContract = HushLedger). */
export const EIP712_NAME = "Hush";
export const EIP712_VERSION = "1";

export const VOUCHER_TYPES = {
  Voucher: [
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "cumulativeSpent", type: "uint256" },
    { name: "nonce", type: "uint64" },
    { name: "requestHash", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export const CREDIT_RECEIPT_TYPES = {
  CreditReceipt: [
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "creditedTotal", type: "uint256" },
    { name: "topupTxHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

export const REFUND_REQUEST_TYPES = {
  RefundRequest: [
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

/**
 * Read access to an agent's credit. A running credit balance moves with every call, so an unauthenticated
 * `GET /credit/:agent` would hand anyone the call frequency and spend hush-credit hides. Signed by the agent or its owner.
 */
export const CREDIT_QUERY_TYPES = {
  CreditQuery: [
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;
/** How long a signed credit query stays valid (it is read-only, so a short replay window is harmless). */
export const CREDIT_QUERY_MAX_AGE_SECONDS = 300;
/** HTTP header carrying `<issuedAt>.<signature>` for `GET /credit/:agent`. */
export const CREDIT_AUTH_HEADER = "x-hush-credit-auth";

/** HushRegistry agent-consent typed data (domain name "HushRegistry", verifyingContract = HushRegistry). */
export const AGENT_CONSENT_TYPES = {
  AgentConsent: [
    { name: "agent", type: "address" },
    { name: "owner", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Merkle leaf encoding — must match HushLedger.voucherLeaf / OZ StandardMerkleTree. */
export const LEAF_TYPES = ["address", "address", "uint256", "uint64", "bytes32", "uint64", "bytes"] as const;

/** eERC transfer proof public-signal layout (transfer.circom / EncryptedERC._executePrivateTransfer). */
export const TRANSFER_SIGNALS = {
  senderPublicKey: [0, 2],
  receiverPublicKey: [10, 12],
  /** Receiver's Poseidon ciphertext of the amount — constrained by the circuit to equal the transferred value. */
  receiverPct: [16, 23],
  auditorPublicKey: [23, 25],
  auditorPct: [25, 32],
} as const;

/** Encrypted-metadata tag an agent (or its owner's treasury) attaches to a top-up. */
export const TOPUP_MEMO_PREFIX = "hush:topup:v1:agent=";
export const REFUND_MEMO = "hush:refund:v1";
