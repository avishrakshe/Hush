/**
 * Adds HushAlpha (v2: desk/signal EIP-712 domain + Proof-of-Alpha chain heads) to an existing deployment without
 * redeploying anything else, and records it in deployments/<network>.json.
 * Usage: pnpm deploy:alpha:fuji   (EPOCH_LEN_SECONDS overrides the epoch; REDEPLOY_ALPHA=1 replaces an existing one)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import hre from "hardhat";
import { type HushDeployment, alphaEpochLen, deployAlphaStack } from "./lib/deployStack";

async function main() {
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`${file} not found — deploy the v1 stack first (pnpm deploy:${network})`);
  const d = JSON.parse(fs.readFileSync(file, "utf8")) as HushDeployment;
  if (d.contracts.HushAlpha && !process.env.REDEPLOY_ALPHA) {
    throw new Error(`HushAlpha already deployed on ${network} (${d.contracts.HushAlpha.address}). Set REDEPLOY_ALPHA=1 to replace it.`);
  }

  const epochLen = alphaEpochLen(network);
  console.log(`Network ${network} · HushAlpha epoch ${epochLen}s`);
  const { HushAlpha } = await deployAlphaStack(hre, { epochLen, log: console.log });

  d.contracts = { ...d.contracts, HushAlpha };
  d.hushAlphaEpochLen = epochLen;
  fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`\nSaved ${path.relative(process.cwd(), file)}\nNext: pnpm export:abis`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
