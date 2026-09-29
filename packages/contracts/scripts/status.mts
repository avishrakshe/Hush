/**
 * Read-only snapshot of a deployment: role AVAX balances, eERC registration, auditor, contract code.
 * Usage: pnpm status   ·   pnpm status:local
 */
import { type Abi, type Address, createPublicClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NET, NETWORK, ROLES, loadAbi, loadDeployment, roleKey } from "./lib/env.mjs";

const d = loadDeployment();
const client = createPublicClient({ transport: http(NET.rpc) });
const registrarAbi = loadAbi("contracts/eerc/Registrar.sol/Registrar.json") as Abi;
const eercAbi = loadAbi("contracts/eerc/EncryptedERC.sol/EncryptedERC.json") as Abi;
const REGISTRAR = d.contracts.Registrar.address as Address;
const EERC = d.contracts.EncryptedERC.address as Address;

console.log(`Network ${NETWORK} · block ${await client.getBlockNumber()} · deployed ${d.deployedAt}`);

const missing: string[] = [];
for (const [name, c] of Object.entries(d.contracts)) {
  const code = await client.getCode({ address: c.address as Address });
  if (!code || code === "0x") missing.push(name);
}
console.log(missing.length ? `MISSING CODE: ${missing.join(", ")}` : `all ${Object.keys(d.contracts).length} contracts have code`);

const rows = [];
for (const role of ROLES) {
  const address = privateKeyToAccount(roleKey(role)).address;
  const [balance, registered] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: REGISTRAR, abi: registrarAbi, functionName: "isUserRegistered", args: [address] }),
  ]);
  rows.push({ role, address, avax: formatEther(balance), eercRegistered: registered });
}
console.table(rows);

const auditor = (await client.readContract({ address: EERC, abi: eercAbi, functionName: "auditor" })) as Address;
console.log(`eERC auditor: ${auditor}`);
