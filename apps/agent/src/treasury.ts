/**
 * Owner treasury — one private eERC balance funding several agents. Observers see transfers between addresses but
 * never how the treasury is split; the owner decrypts allocations locally.
 *
 *   pnpm --filter @hush/agent treasury status
 *   pnpm --filter @hush/agent treasury allocate veil 10        # private transfer of 10 hUSDC to Veil
 *   pnpm --filter @hush/agent treasury fund-credit veil 5      # buy hush-credit for Veil directly from the treasury
 *   pnpm --filter @hush/agent treasury deposit 50              # USDC → hUSDC (public amount)
 *   (add --local for the hardhat node)
 */
import { NETWORK, ROLES, type Role, URLS, loadContracts, publicClient, txLink, wallet } from "@hush/config";
import {
  TOPUP_MEMO_PREFIX,
  atomicToEercExact,
  eercToAtomic,
  formatHusdc,
  hushDomain,
  hushRegistryAbi,
  isValidCreditReceipt,
  mockUsdcAbi,
  receiptFromJson,
} from "@hush/x402";
import { HushFacilitatorApi } from "@hush/x402/client";
import { type Address, formatUnits, getAddress, isAddress, isAddressEqual, parseUnits } from "viem";

const contracts = loadContracts();
const owner = wallet("OWNER");
const eerc = owner.eerc(contracts);
const [command, ...args] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const knownNames = new Map<string, string>(
  ROLES.filter((r) => r !== "DEPLOYER").map((r) => [wallet(r).address.toLowerCase(), r.toLowerCase()]),
);
const nameOf = (a: Address) => knownNames.get(a.toLowerCase()) ?? `${a.slice(0, 8)}…`;
const agentArg = (v: string | undefined): Address => {
  if (!v) throw new Error("expected an agent name (atlas, veil) or address");
  if (isAddress(v)) return getAddress(v);
  const role = v.toUpperCase() as Role;
  if (!ROLES.includes(role)) throw new Error(`unknown agent ${v}`);
  return wallet(role).address;
};
const usd = (v: string | undefined) => {
  if (!v || !/^\d+(\.\d{1,2})?$/.test(v)) throw new Error("amount in USD with at most 2 decimals, e.g. 5 or 2.50");
  return parseUnits(v, 6);
};

async function status() {
  await eerc.init();
  const [bal, usdc, agents] = await Promise.all([
    eerc.balance(),
    publicClient.readContract({ address: contracts.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [owner.address] }),
    publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getAgentsByOwner", args: [owner.address] }),
  ]);
  console.log(`Owner treasury ${owner.address} (${NETWORK})`);
  console.log(`  public USDC      ${formatUnits(usdc, 6)}`);
  console.log(`  private hUSDC    ${formatHusdc(eercToAtomic(bal.decrypted, contracts.eercDecimals))}   (decrypted locally)`);
  console.log(`  agents           ${agents.map((a) => `${nameOf(a)} ${a}`).join(", ") || "none"}`);

  console.log("\nScanning the treasury's private transfers and decrypting them locally…");
  const history = await eerc.history();
  const byCounterparty = new Map<string, { units: bigint; count: number; errors: number }>();
  for (const h of history.filter((x) => x.direction === "out")) {
    const k = h.counterparty.toLowerCase();
    const row = byCounterparty.get(k) ?? { units: 0n, count: 0, errors: 0 };
    row.count++;
    if (h.units !== undefined) row.units += h.units;
    else row.errors++;
    byCounterparty.set(k, row);
  }
  console.table(
    [...byCounterparty.entries()].map(([addr, r]) => ({
      to: nameOf(addr as Address),
      "owner sees (decrypted)": formatHusdc(eercToAtomic(r.units, contracts.eercDecimals)) + (r.errors ? ` (+${r.errors} undecryptable)` : ""),
      "public sees": `${r.count} transfer(s), amounts hidden`,
    })),
  );
}

async function allocate(agent: Address, amount: bigint) {
  const units = atomicToEercExact(amount, contracts.eercDecimals);
  console.log(`Allocating ${formatHusdc(amount)} privately to ${nameOf(agent)} (${agent})…`);
  const { txHash } = await eerc.transfer(agent, units);
  console.log(`  done  ${txLink(txHash)}\n  on-chain: treasury → ${nameOf(agent)}, amount encrypted (only the agent, owner and auditor can read it)`);
}

async function fundCredit(agent: Address, amount: bigint) {
  const providers = (await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getProviders" })) as Address[];
  const provider = providers[0];
  if (!provider) throw new Error("no provider registered");
  const units = atomicToEercExact(amount, contracts.eercDecimals);
  console.log(`Buying ${formatHusdc(amount)} of hush-credit at ${nameOf(provider)} for ${nameOf(agent)}, paid by the treasury…`);
  // The encrypted memo tells only the provider which agent to credit; the facilitator checks HushRegistry ownership.
  const { txHash } = await eerc.transfer(provider, units, `${TOPUP_MEMO_PREFIX}${agent.toLowerCase()}`);
  const res = await new HushFacilitatorApi(URLS.facilitator).topUp(agent, txHash);
  const receipt = receiptFromJson(res.receipt);
  const valid = await isValidCreditReceipt(hushDomain(contracts.chainId, contracts.hushLedger), receipt, res.signature);
  if (!valid || !isAddressEqual(receipt.agent, agent)) throw new Error("facilitator returned an invalid receipt");
  console.log(`  top-up ${txLink(txHash)}`);
  console.log(`  provider-signed receipt: ${nameOf(agent)} credited ${formatHusdc(BigInt(res.amount))}, creditedTotal ${formatHusdc(receipt.creditedTotal)}`);
  console.log(`  on-chain: treasury → provider, amount hidden; nothing links the payment to ${nameOf(agent)} except the encrypted memo`);
}

async function deposit(amount: bigint) {
  const bal = await publicClient.readContract({ address: contracts.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [owner.address] });
  if (bal < amount) {
    const hash = await owner.walletClient.writeContract({ address: contracts.usdc, abi: mockUsdcAbi, functionName: "mint", args: [owner.address, amount] });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  minted ${formatUnits(amount, 6)} test USDC  ${txLink(hash)}`);
  }
  const hash = await eerc.deposit(amount);
  console.log(`Deposited ${formatUnits(amount, 6)} USDC into the treasury's private balance (the deposit amount is public)  ${txLink(hash)}`);
}

try {
  switch (command) {
    case "status":
    case undefined:
      await status();
      break;
    case "allocate":
      await allocate(agentArg(args[0]), usd(args[1]));
      break;
    case "fund-credit":
      await fundCredit(agentArg(args[0]), usd(args[1]));
      break;
    case "deposit":
      await deposit(usd(args[0]));
      break;
    default:
      throw new Error(`unknown command ${command} (status | allocate | fund-credit | deposit)`);
  }
  process.exit(0); // snarkjs keeps worker threads alive
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
