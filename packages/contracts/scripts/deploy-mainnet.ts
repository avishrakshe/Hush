/**
 * Avalanche C-Chain mainnet: HushRegistry + HushLedger (and HushAlpha with WITH_ALPHA=1) — the accountability layer,
 * no eERC, no mocks. HushRegistry gets eercRegistrar = address(0), which disables the provider-key cross-check.
 *
 * Real AVAX. Safe by default:
 *   - signs with MAINNET_DEPLOYER_PRIVATE_KEY only (never the testnet role keys in .env);
 *   - without CONFIRM_MAINNET=yes it is a dry run: prints the deployer, its balance and the estimated cost, sends nothing.
 *
 *   MAINNET_DEPLOYER_PRIVATE_KEY=0x… pnpm deploy:mainnet                      # dry run
 *   MAINNET_DEPLOYER_PRIVATE_KEY=0x… CONFIRM_MAINNET=yes pnpm deploy:mainnet  # deploy
 */
import * as fs from "node:fs";
import * as path from "node:path";
import hre from "hardhat";
import type { DeployedContract } from "./lib/types";

async function main() {
  const { ethers, network } = hre;
  if (network.name !== "avalanche") throw new Error(`run with --network avalanche (got ${network.name})`);
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("MAINNET_DEPLOYER_PRIVATE_KEY is not set");
  const withAlpha = process.env.WITH_ALPHA === "1";
  const confirmed = process.env.CONFIRM_MAINNET === "yes";

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 43114) throw new Error(`expected chainId 43114, RPC reports ${chainId}`);
  const balance = await ethers.provider.getBalance(signer.address);
  const fee = await ethers.provider.getFeeData();
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;

  // HushLedger's constructor needs the registry address; any non-zero placeholder gives the same gas estimate.
  const plan: [string, unknown[]][] = [
    ["HushRegistry", [ethers.ZeroAddress]],
    ["HushLedger", ["0x0000000000000000000000000000000000000001"]],
    ...(withAlpha ? ([["HushAlpha", [600]]] as [string, unknown[]][]) : []),
  ];
  let gas = 0n;
  for (const [name, args] of plan) {
    const f = await ethers.getContractFactory(name);
    gas += await ethers.provider.estimateGas({ ...(await f.getDeployTransaction(...args)), from: signer.address });
  }
  const cost = gas * gasPrice;
  console.log(`Avalanche C-Chain mainnet · deployer ${signer.address}`);
  console.log(`  balance   ${ethers.formatEther(balance)} AVAX`);
  console.log(`  deploys   ${plan.map(([n]) => n).join(", ")}`);
  console.log(`  estimate  ${gas} gas × ${ethers.formatUnits(gasPrice, "gwei")} gwei ≈ ${ethers.formatEther(cost)} AVAX (max fee)`);
  if (balance < cost) throw new Error("deployer balance is below the estimated cost");
  if (!confirmed) {
    console.log("\nDry run — nothing sent. Re-run with CONFIRM_MAINNET=yes to deploy.");
    return;
  }

  const deploy = async (name: string, args: unknown[]): Promise<DeployedContract> => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    const receipt = await c.deploymentTransaction()!.wait();
    const d = { address: await c.getAddress(), txHash: receipt!.hash, blockNumber: receipt!.blockNumber };
    console.log(`  ${name.padEnd(13)} ${d.address}  https://snowtrace.io/tx/${d.txHash}`);
    return d;
  };
  const HushRegistry = await deploy("HushRegistry", [ethers.ZeroAddress]);
  const HushLedger = await deploy("HushLedger", [HushRegistry.address]);
  const HushAlpha = withAlpha ? await deploy("HushAlpha", [600]) : undefined;

  const file = path.join(__dirname, "..", "deployments", "avalanche.json");
  const out = {
    network: "avalanche",
    chainId,
    deployer: signer.address,
    deployedAt: new Date().toISOString(),
    note: "Accountability layer only: no eERC on this deployment (HushRegistry.eercRegistrar = 0x0).",
    contracts: { HushRegistry, HushLedger, ...(HushAlpha && { HushAlpha }) },
    ...(HushAlpha && { hushAlphaEpochLen: 600 }),
  };
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nSaved ${path.relative(process.cwd(), file)} · spent ${ethers.formatEther(balance - (await ethers.provider.getBalance(signer.address)))} AVAX`);
  console.log("Verify: pnpm --filter @hush/contracts verify:mainnet");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
