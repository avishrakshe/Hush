/**
 * Verifies every deployed contract on Snowtrace (via Routescan). Safe to re-run.
 * Usage: pnpm --filter @hush/contracts verify:fuji
 */
import * as fs from "node:fs";
import * as path from "node:path";
import hre from "hardhat";
import type { HushDeployment } from "./lib/deployStack";

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8")) as HushDeployment;
  const c = d.contracts;

  const jobs: { name: string; address: string; constructorArguments: unknown[]; libraries?: Record<string, string> }[] = [
    { name: "RegistrationVerifier", address: c.RegistrationVerifier.address, constructorArguments: [] },
    { name: "MintVerifier", address: c.MintVerifier.address, constructorArguments: [] },
    { name: "WithdrawVerifier", address: c.WithdrawVerifier.address, constructorArguments: [] },
    { name: "TransferVerifier", address: c.TransferVerifier.address, constructorArguments: [] },
    { name: "BurnVerifier", address: c.BurnVerifier.address, constructorArguments: [] },
    { name: "BabyJubJub", address: c.BabyJubJub.address, constructorArguments: [] },
    { name: "Registrar", address: c.Registrar.address, constructorArguments: [c.RegistrationVerifier.address] },
    {
      name: "EncryptedERC",
      address: c.EncryptedERC.address,
      constructorArguments: [
        {
          registrar: c.Registrar.address,
          isConverter: true,
          name: "",
          symbol: "",
          decimals: d.eercDecimals,
          mintVerifier: c.MintVerifier.address,
          withdrawVerifier: c.WithdrawVerifier.address,
          transferVerifier: c.TransferVerifier.address,
          burnVerifier: c.BurnVerifier.address,
        },
      ],
      libraries: { "contracts/eerc/libraries/BabyJubJub.sol:BabyJubJub": c.BabyJubJub.address },
    },
    { name: "MockUSDC", address: c.MockUSDC.address, constructorArguments: [] },
    { name: "HushRegistry", address: c.HushRegistry.address, constructorArguments: [c.Registrar.address] },
    { name: "HushLedger", address: c.HushLedger.address, constructorArguments: [c.HushRegistry.address] },
  ];

  for (const job of jobs) {
    try {
      await hre.run("verify:verify", {
        address: job.address,
        constructorArguments: job.constructorArguments,
        libraries: job.libraries,
      });
      console.log(`✔ ${job.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(/already verified/i.test(msg) ? `✔ ${job.name} (already verified)` : `✘ ${job.name}: ${msg.split("\n")[0]}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
