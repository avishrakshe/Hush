// Shape of deployments/<network>.json. Kept free of Hardhat imports so ESM tooling (SDK, facilitator,
// .mts scripts) can import it without pulling in the Hardhat runtime.

export interface DeployedContract {
  address: string;
  txHash: string;
  blockNumber: number;
}

export interface HushDeployment {
  network: string;
  chainId: number;
  deployer: string;
  deployedAt: string;
  eercDecimals: number;
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
  };
}
