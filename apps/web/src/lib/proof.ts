/** Shape of GET /api/proof: a public snapshot of the Hush deployment on Fuji — only what anyone can read on-chain. */
export interface ProofSnapshot {
  chainId: number;
  blockNumber: string;
  fetchedAt: number;
  contracts: { name: string; role: string; address: string }[];
  auditor: { address: string; keySet: boolean };
  /** USDC held by the eERC converter. Deposits are public, so this total is too. */
  lockedUsdc: string;
  providers: {
    address: string;
    name: string;
    endpoint: string;
    pricePerCall: string;
    facilitator: string;
    flagCount: number;
    latestBatchId: string;
    roots: { batchId: string; root: string }[];
    /** The provider's eERC balance as the chain stores it: an ElGamal ciphertext (two BabyJubJub points). */
    encryptedBalance: { c1: [string, string]; c2: [string, string] };
  }[];
}
