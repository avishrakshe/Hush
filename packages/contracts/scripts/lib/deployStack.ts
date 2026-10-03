import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { type DeployedContract, type HushDeployment, STOCK_FAUCET_CAP, STOCKS, type StockContracts } from "./types";

export type { DeployedContract, HushDeployment, StockContracts } from "./types";
export { STOCK_FAUCET_CAP, STOCKS, alphaEpochLen } from "./types";

/** eERC token decimals. 2 matches the reference converter deployment (0.01 hUSDC granularity). */
export const EERC_DECIMALS = 2;

function contractDeployer(hre: HardhatRuntimeEnvironment, log: (msg: string) => void) {
  return async (name: string, args: unknown[] = [], libraries?: Record<string, string>, label = name): Promise<DeployedContract> => {
    const factory = await hre.ethers.getContractFactory(name, { libraries });
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    const tx = contract.deploymentTransaction();
    const receipt = tx ? await tx.wait() : null;
    const deployed = {
      address: await contract.getAddress(),
      txHash: tx?.hash ?? "",
      blockNumber: receipt?.blockNumber ?? 0,
    };
    log(`  ${label.padEnd(22)} ${deployed.address}`);
    return deployed;
  };
}

/**
 * Deploys the full Hush stack: eERC (converter mode, prod verifiers) + MockUSDC + HushRegistry + HushLedger.
 * The prod verifiers match the prebuilt circuits in /circuits (same trusted setup), which is what lets the
 * eERC SDK's proofs verify on-chain.
 */
export async function deployHushStack(
  hre: HardhatRuntimeEnvironment,
  opts: { log?: (msg: string) => void } = {},
): Promise<HushDeployment> {
  const { ethers } = hre;
  const log = opts.log ?? (() => {});
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer configured (set DEPLOYER_PRIVATE_KEY in .env)");
  const deploy = contractDeployer(hre, log);

  const RegistrationVerifier = await deploy("RegistrationVerifier");
  const MintVerifier = await deploy("MintVerifier");
  const WithdrawVerifier = await deploy("WithdrawVerifier");
  const TransferVerifier = await deploy("TransferVerifier");
  const BurnVerifier = await deploy("BurnVerifier");
  const BabyJubJub = await deploy("BabyJubJub");
  const Registrar = await deploy("Registrar", [RegistrationVerifier.address]);

  const EncryptedERC = await deploy(
    "EncryptedERC",
    [
      {
        registrar: Registrar.address,
        isConverter: true, // wraps an existing ERC-20 (USDC) instead of minting a new private token
        name: "",
        symbol: "",
        decimals: EERC_DECIMALS,
        mintVerifier: MintVerifier.address,
        withdrawVerifier: WithdrawVerifier.address,
        transferVerifier: TransferVerifier.address,
        burnVerifier: BurnVerifier.address,
      },
    ],
    { "contracts/eerc/libraries/BabyJubJub.sol:BabyJubJub": BabyJubJub.address },
  );

  const MockUSDC = await deploy("MockUSDC");
  const HushRegistry = await deploy("HushRegistry", [Registrar.address]);
  const HushLedger = await deploy("HushLedger", [HushRegistry.address]);

  const network = await ethers.provider.getNetwork();
  return {
    network: hre.network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    eercDecimals: EERC_DECIMALS,
    contracts: {
      RegistrationVerifier,
      MintVerifier,
      WithdrawVerifier,
      TransferVerifier,
      BurnVerifier,
      BabyJubJub,
      Registrar,
      EncryptedERC,
      MockUSDC,
      HushRegistry,
      HushLedger,
    },
  };
}

/**
 * v2: MockStockOracle + one MockStock per ticker, with a seed round per ticker so quotes and signals work immediately.
 * Independent of the v1 stack, so it can be added to a live deployment (`deploy-stocks.ts`) without touching it.
 * The eERC converter needs no change: each stock registers itself on its first deposit (the desk's inventory).
 */
export async function deployStockStack(
  hre: HardhatRuntimeEnvironment,
  opts: { log?: (msg: string) => void } = {},
): Promise<StockContracts> {
  const { ethers } = hre;
  const deploy = contractDeployer(hre, opts.log ?? (() => {}));

  const MockStockOracle = await deploy("MockStockOracle");
  const tokens = {} as Record<(typeof STOCKS)[number]["symbol"], DeployedContract>;
  for (const s of STOCKS) {
    tokens[s.symbol] = await deploy("MockStock", [s.name, s.symbol, ethers.encodeBytes32String(s.ticker), STOCK_FAUCET_CAP], undefined, s.symbol);
  }

  const oracle = await ethers.getContractAt("MockStockOracle", MockStockOracle.address);
  const tx = await oracle.postPrices(
    STOCKS.map((s) => ethers.encodeBytes32String(s.ticker)),
    STOCKS.map((s) => s.seedPrice),
  );
  await tx.wait();

  return { MockStockOracle, ...tokens };
}

/**
 * v2: HushAlpha — EIP-712 domain for desk quotes/fills/statements and signal records, plus per-epoch chain heads.
 * Standalone (no constructor dependencies), so it can be added to a live deployment with `deploy-alpha.ts`.
 */
export async function deployAlphaStack(
  hre: HardhatRuntimeEnvironment,
  opts: { epochLen: number; log?: (msg: string) => void },
): Promise<{ HushAlpha: DeployedContract }> {
  const deploy = contractDeployer(hre, opts.log ?? (() => {}));
  return { HushAlpha: await deploy("HushAlpha", [opts.epochLen]) };
}
