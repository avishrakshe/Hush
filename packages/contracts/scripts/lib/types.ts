// Shape of deployments/<network>.json. Kept free of Hardhat imports so ESM tooling (SDK, facilitator,
// .mts scripts) can import it without pulling in the Hardhat runtime.

export interface DeployedContract {
  address: string;
  txHash: string;
  blockNumber: number;
}

/**
 * v2 mock stocks. Contract keys in the deployment are `m${ticker}`; seed prices are USDC atomic (6 dp) per share.
 * Names say "Mock" on purpose: these are not issuer tokens and claim no affiliation.
 */
export const STOCKS = [
  { ticker: "NVDA", symbol: "mNVDA", name: "Hush Mock NVDA", seedPrice: 180_000_000n },
  { ticker: "TSLA", symbol: "mTSLA", name: "Hush Mock TSLA", seedPrice: 250_000_000n },
  { ticker: "SPY", symbol: "mSPY", name: "Hush Mock SPY", seedPrice: 570_000_000n },
] as const;
/** Lifetime faucet allowance per address: 10 shares (18 dp). */
export const STOCK_FAUCET_CAP = 10n * 10n ** 18n;

export interface StockContracts {
  MockStockOracle: DeployedContract;
  mNVDA: DeployedContract;
  mTSLA: DeployedContract;
  mSPY: DeployedContract;
}

/**
 * Proof-of-Alpha epoch length. Fuji: 10 minutes. Local chains: 1 minute, so a demo shows committed epochs (and a
 * provider's chain diverging) in minutes rather than hours.
 */
export const alphaEpochLen = (network: string) => Number(process.env.EPOCH_LEN_SECONDS || (network === "localhost" ? 60 : 600));

export interface HushDeployment {
  network: string;
  chainId: number;
  deployer: string;
  deployedAt: string;
  eercDecimals: number;
  /** Set when the v2 stock contracts were added to an existing deployment. */
  stocksDeployedAt?: string;
  /** HushAlpha constructor argument (seconds), recorded for verification and clients. */
  hushAlphaEpochLen?: number;
  contracts: {
    RegistrationVerifier: DeployedContract;
    MintVerifier: DeployedContract;
    WithdrawVerifier: DeployedContract;
    TransferVerifier: DeployedContract;
    BurnVerifier: DeployedContract;
    BabyJubJub: DeployedContract;
    Registrar: DeployedContract;
    EncryptedERC: DeployedContract;
    MockUSDC: DeployedContract;
    HushRegistry: DeployedContract;
    HushLedger: DeployedContract;
  } & Partial<StockContracts> & { HushAlpha?: DeployedContract };
}
