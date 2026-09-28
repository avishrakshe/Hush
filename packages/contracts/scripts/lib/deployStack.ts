import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployedContract, HushDeployment } from "./types";

export type { DeployedContract, HushDeployment } from "./types";

/** eERC token decimals. 2 matches the reference converter deployment (0.01 hUSDC granularity). */
export const EERC_DECIMALS = 2;

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

  const deploy = async (
    name: string,
    args: unknown[] = [],
    libraries?: Record<string, string>,
  ): Promise<DeployedContract> => {
    const factory = await ethers.getContractFactory(name, { libraries });
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    const tx = contract.deploymentTransaction();
    const receipt = tx ? await tx.wait() : null;
    const deployed = {
      address: await contract.getAddress(),
      txHash: tx?.hash ?? "",
      blockNumber: receipt?.blockNumber ?? 0,
    };
    log(`  ${name.padEnd(22)} ${deployed.address}`);
    return deployed;
  };

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
