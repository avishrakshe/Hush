/**
 * Creates (or completes) the repo-root .env with a fresh testnet key for every Hush role.
 * Existing valid keys are never overwritten. Prints addresses only — never private keys.
 */
import { Wallet } from "ethers";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENV_PATH, REPO_ROOT, ROLES, isPrivateKey } from "./lib/env.mjs";

const created = !existsSync(ENV_PATH);
let text = readFileSync(created ? path.join(REPO_ROOT, ".env.example") : ENV_PATH, "utf8");

const rows: { role: string; address: string; status: string }[] = [];
for (const role of ROLES) {
  const name = `${role}_PRIVATE_KEY`;
  const re = new RegExp(`^${name}=(.*)$`, "m");
  const match = text.match(re);
  let key = match?.[1]?.trim();
  let status = "kept";
  if (!isPrivateKey(key)) {
    key = Wallet.createRandom().privateKey;
    status = "generated";
    text = match ? text.replace(re, `${name}=${key}`) : `${text.trimEnd()}\n${name}=${key}\n`;
  }
  rows.push({ role, address: new Wallet(key).address, status });
}

// Bearer token for the facilitator's provider-console endpoints (/admin/*).
const tokenRe = /^PROVIDER_ADMIN_TOKEN=(.*)$/m;
if (!text.match(tokenRe)?.[1]?.trim()) {
  const token = Wallet.createRandom().privateKey.slice(2, 34);
  text = text.match(tokenRe) ? text.replace(tokenRe, `PROVIDER_ADMIN_TOKEN=${token}`) : `${text.trimEnd()}\n\n# Facilitator provider-console token\nPROVIDER_ADMIN_TOKEN=${token}\n`;
}

writeFileSync(ENV_PATH, text);
console.log(`${created ? "Created" : "Updated"} ${ENV_PATH}\n`);
console.table(rows);

const deployer = rows[0]!.address;
console.log(`
Next: fund the DEPLOYER with Fuji test AVAX (only this address needs faucet funds):
  ${deployer}
  Faucet:   https://core.app/tools/testnet-faucet/?subnet=c&token=c
  Explorer: https://testnet.snowtrace.io/address/${deployer}
Fuji gas is ~free, so even 0.1 AVAX is plenty; \`pnpm fund:fuji\` then forwards AVAX to the other roles.`);
