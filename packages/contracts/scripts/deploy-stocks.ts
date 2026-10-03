/**
 * Adds the v2 mock stocks (MockStockOracle + mNVDA/mTSLA/mSPY) to an existing deployment without redeploying the
 * v1 stack, and records them in deployments/<network>.json.
 * Usage: pnpm deploy:stocks:fuji   (set REDEPLOY_STOCKS=1 to replace stocks that are already deployed)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import hre from "hardhat";
import { type HushDeployment, deployStockStack } from "./lib/deployStack";

async function main() {
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`${file} not found — deploy the v1 stack first (pnpm deploy:${network})`);
  const d = JSON.parse(fs.readFileSync(file, "utf8")) as HushDeployment;
  if (d.contracts.MockStockOracle && !process.env.REDEPLOY_STOCKS) {
    throw new Error(`stocks already deployed on ${network} (oracle ${d.contracts.MockStockOracle.address}). Set REDEPLOY_STOCKS=1 to replace them.`);
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("Set DEPLOYER_PRIVATE_KEY in .env");
  console.log(`Network ${network} · deployer ${deployer.address} · ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))} AVAX`);
  console.log("Deploying stocks:");
  const stocks = await deployStockStack(hre, { log: console.log });

  d.contracts = { ...d.contracts, ...stocks };
  d.stocksDeployedAt = new Date().toISOString();
  fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`\nSaved ${path.relative(process.cwd(), file)}`);
  console.log("Next: pnpm export:abis && pnpm bootstrap   (sets the price-bot updater, desk inventory → eERC tokenIds)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
