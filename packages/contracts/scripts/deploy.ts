/**
 * Deploys the full Hush stack and records addresses in deployments/<network>.json.
 * Usage: pnpm deploy:fuji   (set REDEPLOY=1 to replace an existing deployment)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import hre from "hardhat";
import { alphaEpochLen, deployAlphaStack, deployHushStack, deployStockStack } from "./lib/deployStack";

const EXPLORERS: Record<string, string> = {
  fuji: "https://testnet.snowtrace.io",
  avalanche: "https://snowtrace.io",
};

async function main() {
  const network = hre.network.name;
  const outFile = path.join(__dirname, "..", "deployments", `${network}.json`);
  // A local node starts empty every run, so localhost deployments are always replaced.
  if (fs.existsSync(outFile) && !process.env.REDEPLOY && network !== "localhost") {
    throw new Error(`${outFile} already exists. Set REDEPLOY=1 to deploy a fresh stack.`);
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("Set DEPLOYER_PRIVATE_KEY in .env (run `pnpm keys`)");
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Network ${network} · deployer ${deployer.address} · ${hre.ethers.formatEther(balance)} AVAX`);
  if (balance === 0n) {
    throw new Error(
      network === "localhost"
        ? "Deployer has no balance on the local node — run `pnpm fund:local` first."
        : "Deployer has no AVAX — fund it from the Fuji faucet first.",
    );
  }

  console.log("Deploying:");
  const deployment = await deployHushStack(hre, { log: console.log });
  // A fresh deployment always includes the v2 contracts; live deployments get them via deploy-stocks.ts / deploy-alpha.ts.
  deployment.contracts = { ...deployment.contracts, ...(await deployStockStack(hre, { log: console.log })) };
  const epochLen = alphaEpochLen(network);
  deployment.contracts = { ...deployment.contracts, ...(await deployAlphaStack(hre, { epochLen, log: console.log })) };
  deployment.hushAlphaEpochLen = epochLen;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(deployment, null, 2)}\n`);

  const explorer = EXPLORERS[network];
  console.log(`\nSaved ${path.relative(process.cwd(), outFile)}`);
  if (explorer) {
    console.log("\nSnowtrace:");
    for (const [name, c] of Object.entries(deployment.contracts)) {
      console.log(`  ${name.padEnd(22)} ${explorer}/address/${c.address}`);
    }
  }
  console.log("\nNext: pnpm fund:fuji && pnpm prove:fuji   (optional: pnpm --filter @hush/contracts verify:fuji)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
