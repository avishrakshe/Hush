/**
 * Idempotent network setup for the Hush demo (safe to re-run):
 *   1. eERC keys for auditor, owner, Veil and the provider (registration proofs)
 *   2. eERC auditor = AUDITOR (set by DEPLOYER, the eERC owner)
 *   3. provider listed in HushRegistry (eERC key cross-checked) + facilitator gas key authorised
 *   4. Atlas and Veil registered under OWNER (each signs an EIP-712 consent)
 *   5. USDC: owner treasury + Atlas (public agent pays plain USDC via EIP-3009)
 *   6. owner deposits into eERC and privately allocates hUSDC to Veil (treasury → agent, amount hidden)
 *
 * Usage: pnpm bootstrap        (Fuji)   ·   pnpm bootstrap:local   (hardhat node)
 */
import { NETWORK, addrLink, loadContracts, publicClient, txLink, wallet } from "@hush/config";
import {
  encryptedErcAbi,
  eercToAtomic,
  formatHusdc,
  hushRegistryAbi,
  mockUsdcAbi,
  registerAgent,
  registerProvider,
  setFacilitator,
  signAgentConsent,
} from "@hush/x402";
import { type Address, formatUnits, isAddressEqual } from "viem";

const contracts = loadContracts();
const [deployer, auditor, owner, atlas, veil, provider, facilitator] = (
  ["DEPLOYER", "AUDITOR", "OWNER", "ATLAS", "VEIL", "PROVIDER", "FACILITATOR"] as const
).map((r) => wallet(r));

const PROVIDER_ENDPOINT = process.env.PROVIDER_URL || "http://localhost:4021";
const OWNER_USDC = 200_000_000n; // 200 USDC treasury
const ATLAS_USDC = 50_000_000n; //   50 USDC for public calls
const OWNER_DEPOSIT = 100_000_000n; // 100 USDC → hUSDC
const VEIL_ALLOCATION = 2_500n; //      25.00 hUSDC (eERC units) privately allocated to Veil

const step = (n: number, title: string) => console.log(`\n${n}. ${title}`);
const ok = (msg: string) => console.log(`   ✓ ${msg}`);

async function waitOk(hash: `0x${string}`, label: string) {
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${txLink(hash)}`);
  ok(`${label}  ${txLink(hash)}`);
}

async function main() {
  console.log(`Bootstrapping Hush on ${NETWORK} (chain ${contracts.chainId})`);
  console.log(`eERC ${addrLink(contracts.encryptedErc)} · registry ${addrLink(contracts.hushRegistry)}`);

  step(1, "eERC keys (client-side registration proofs)");
  for (const w of [auditor!, owner!, veil!, provider!]) {
    const hash = await w.eerc(contracts).register();
    ok(`${w.role.padEnd(9)} ${hash ? `registered  ${txLink(hash)}` : "already registered"}`);
  }

  step(2, "eERC auditor");
  const current = (await publicClient.readContract({ address: contracts.encryptedErc, abi: encryptedErcAbi, functionName: "auditor" })) as Address;
  if (!isAddressEqual(current, auditor!.address)) {
    const hash = await deployer!.walletClient.writeContract({
      address: contracts.encryptedErc,
      abi: encryptedErcAbi,
      functionName: "setAuditorPublicKey",
      args: [auditor!.address],
    });
    await waitOk(hash, `auditor → ${auditor!.address}`);
  } else ok(`auditor already ${auditor!.address}`);

  step(3, "provider in HushRegistry");
  const isProvider = await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "isProvider", args: [provider!.address] });
  if (!isProvider) {
    const eerc = await provider!.eerc(contracts).init();
    const hash = await registerProvider(provider!.walletClient, publicClient, {
      registry: contracts.hushRegistry,
      name: "Hush PriceFeed",
      endpoint: `${PROVIDER_ENDPOINT}/api/feed`,
      pricePerCall: 20_000n,
      eercPublicKey: eerc.publicKey,
    });
    ok(`registered provider ${provider!.address}  ${txLink(hash)}`);
  } else ok(`provider ${provider!.address} already registered`);
  const p = await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getProvider", args: [provider!.address] });
  if (!isAddressEqual(p.facilitator, facilitator!.address)) {
    ok(`facilitator authorised  ${txLink(await setFacilitator(provider!.walletClient, publicClient, contracts.hushRegistry, facilitator!.address))}`);
  } else ok(`facilitator ${facilitator!.address} already authorised`);

  step(4, "agents in HushRegistry (owner = OWNER, each agent signs consent)");
  for (const agent of [atlas!, veil!]) {
    const isAgent = await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "isAgent", args: [agent.address] });
    if (isAgent) {
      ok(`${agent.role} already registered`);
      continue;
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const consent = await signAgentConsent(agent.account, { registry: contracts.hushRegistry, chainId: contracts.chainId, owner: owner!.address, deadline });
    const hash = await registerAgent(owner!.walletClient, publicClient, {
      registry: contracts.hushRegistry,
      agent: agent.address,
      metadataURI: `hush://agent/${agent.role.toLowerCase()}`,
      deadline,
      consent,
    });
    ok(`${agent.role} ${agent.address}  ${txLink(hash)}`);
  }

  step(5, "USDC (MockUSDC faucet)");
  for (const [w, target] of [[owner!, OWNER_USDC], [atlas!, ATLAS_USDC]] as const) {
    const bal = await publicClient.readContract({ address: contracts.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [w.address] });
    if (bal >= target / 2n) {
      ok(`${w.role} has ${formatUnits(bal, 6)} USDC`);
      continue;
    }
    const hash = await w.walletClient.writeContract({ address: contracts.usdc, abi: mockUsdcAbi, functionName: "mint", args: [w.address, target] });
    await waitOk(hash, `minted ${formatUnits(target, 6)} USDC to ${w.role}`);
  }

  step(6, "owner treasury → encrypted hUSDC → private allocation to Veil");
  const ownerEerc = owner!.eerc(contracts);
  const veilEerc = veil!.eerc(contracts);
  let ownerBal = await ownerEerc.balance();
  if (ownerBal.decrypted < VEIL_ALLOCATION) {
    const hash = await ownerEerc.deposit(OWNER_DEPOSIT);
    ok(`deposited ${formatUnits(OWNER_DEPOSIT, 6)} USDC (public amount)  ${txLink(hash)}`);
    ownerBal = await ownerEerc.balance();
  }
  ok(`owner private balance: ${formatHusdc(eercToAtomic(ownerBal.decrypted, contracts.eercDecimals))}`);
  const veilBal = await veilEerc.balance();
  if (veilBal.decrypted < VEIL_ALLOCATION / 2n) {
    const { txHash } = await ownerEerc.transfer(veil!.address, VEIL_ALLOCATION);
    const { units } = await veilEerc.decryptIncoming(txHash);
    ok(`allocated privately to Veil; Veil decrypts ${formatHusdc(eercToAtomic(units, contracts.eercDecimals))}  ${txLink(txHash)}`);
  } else ok(`Veil already holds ${formatHusdc(eercToAtomic(veilBal.decrypted, contracts.eercDecimals))}`);

  console.log("\nBootstrap complete. Next: start the facilitator and the provider, then run the e2e check.");
}

main()
  .then(() => process.exit(0)) // snarkjs keeps worker threads alive
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
