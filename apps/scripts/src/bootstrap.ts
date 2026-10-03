/**
 * Idempotent network setup for the Hush demo (safe to re-run):
 *   1. eERC keys for auditor, owner, Veil and the provider (registration proofs)
 *   2. eERC auditor = AUDITOR (set by DEPLOYER, the eERC owner)
 *   3. provider listed in HushRegistry (eERC key cross-checked) + facilitator gas key authorised
 *   4. Atlas and Veil registered under OWNER (each signs an EIP-712 consent)
 *   5. USDC: owner treasury + Atlas (public agent pays plain USDC via EIP-3009)
 *   6. owner deposits into eERC and privately allocates hUSDC to Veil (treasury → agent, amount hidden)
 *   7. v2 stocks (when deployed): PRICEBOT oracle updater · desk eERC key + HushRegistry listing · desk inventory
 *      (plain mStock for the public path; part deposited into eERC, which registers each stock's tokenId)
 *
 * Usage: pnpm bootstrap        (Fuji)   ·   pnpm bootstrap:local   (hardhat node)
 */
import { NETWORK, addrLink, loadContracts, publicClient, txLink, wallet } from "@hush/config";
import {
  STOCK_TICKERS,
  encryptedErcAbi,
  eercToAtomic,
  formatHusdc,
  hushRegistryAbi,
  mockStockAbi,
  mockStockOracleAbi,
  mockUsdcAbi,
  registerAgent,
  registerProvider,
  setFacilitator,
  signAgentConsent,
} from "@hush/x402";
import { type Address, formatUnits, isAddressEqual, parseUnits } from "viem";

const contracts = loadContracts();
const [deployer, auditor, owner, atlas, veil, provider, facilitator, desk, pricebot] = (
  ["DEPLOYER", "AUDITOR", "OWNER", "ATLAS", "VEIL", "PROVIDER", "FACILITATOR", "DESK", "PRICEBOT"] as const
).map((r) => wallet(r));

const PROVIDER_ENDPOINT = process.env.PROVIDER_URL || "http://localhost:4021";
const DESK_ENDPOINT = process.env.DESK_URL || "http://localhost:4023";
const DESK_PUBLIC_INVENTORY = parseUnits("500", 18); //  plain mStock per ticker, delivered publicly to `exact` buyers
const DESK_PRIVATE_INVENTORY = parseUnits("100", 18); // per ticker into eERC (hStock), for private settle-outs
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

  if (contracts.stockOracle && contracts.stocks) await bootstrapStocks(contracts.stockOracle, contracts.stocks);
  else console.log("\n(no mock stocks in this deployment — skipping v2 setup; `pnpm deploy:stocks:fuji` adds them)");

  console.log("\nBootstrap complete. Next: start the facilitator and the provider, then run the e2e check.");
}

async function bootstrapStocks(oracle: Address, stocks: NonNullable<typeof contracts.stocks>) {
  step(7, "v2 mock stocks: oracle updater, desk, desk inventory");
  const isUpdater = await publicClient.readContract({ address: oracle, abi: mockStockOracleAbi, functionName: "isUpdater", args: [pricebot!.address] });
  if (!isUpdater) {
    const hash = await deployer!.walletClient.writeContract({ address: oracle, abi: mockStockOracleAbi, functionName: "setUpdater", args: [pricebot!.address, true] });
    await waitOk(hash, `oracle updater → PRICEBOT ${pricebot!.address}`);
  } else ok(`PRICEBOT ${pricebot!.address} already updates the oracle`);

  const deskEerc = desk!.eerc(contracts);
  const regHash = await deskEerc.register();
  ok(`DESK eERC key ${regHash ? `registered  ${txLink(regHash)}` : "already registered"}`);

  const isProvider = await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "isProvider", args: [desk!.address] });
  if (!isProvider) {
    // A normal provider listing: agents top up hUSDC to the key below, and the desk commits voucher batches itself.
    const hash = await registerProvider(desk!.walletClient, publicClient, {
      registry: contracts.hushRegistry,
      name: "Hush Desk",
      endpoint: `${DESK_ENDPOINT}/rfq`,
      pricePerCall: 0n, // quotes are priced per request
      eercPublicKey: (await deskEerc.init()).publicKey,
    });
    ok(`registered desk ${desk!.address} as a provider  ${txLink(hash)}`);
  } else ok(`desk ${desk!.address} already registered`);

  for (const ticker of STOCK_TICKERS) {
    const token = stocks[ticker];
    if (!token) continue;
    const plain = await publicClient.readContract({ address: token, abi: mockStockAbi, functionName: "balanceOf", args: [desk!.address] });
    if (plain < DESK_PUBLIC_INVENTORY / 2n) {
      const amount = DESK_PUBLIC_INVENTORY + DESK_PRIVATE_INVENTORY;
      const hash = await deployer!.walletClient.writeContract({ address: token, abi: mockStockAbi, functionName: "mint", args: [desk!.address, amount] });
      await waitOk(hash, `minted ${formatUnits(amount, 18)} m${ticker} to the desk`);
    }
    // Inventory deposits are public (amount + token); what stays private is who later holds which position.
    const priv = await deskEerc.balance(desk!.address, token);
    if (priv.decrypted < eercUnits(DESK_PRIVATE_INVENTORY) / 2n) {
      const hash = await deskEerc.deposit(DESK_PRIVATE_INVENTORY, undefined, token);
      ok(`desk deposited ${formatUnits(DESK_PRIVATE_INVENTORY, 18)} m${ticker} into eERC  ${txLink(hash)}`);
    }
    const tokenId = await publicClient.readContract({ address: contracts.encryptedErc, abi: encryptedErcAbi, functionName: "tokenIds", args: [token] });
    const held = (await deskEerc.balance(desk!.address, token)).decrypted;
    ok(`h${ticker}: eERC tokenId ${tokenId} · desk holds ${formatUnits(held, contracts.eercDecimals)} private shares`);
  }
}

/** 18-dp share amount → eERC units (0.01 share each with 2 eERC decimals). */
const eercUnits = (wei: bigint) => wei / 10n ** BigInt(18 - contracts.eercDecimals);

main()
  .then(() => process.exit(0)) // snarkjs keeps worker threads alive
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
