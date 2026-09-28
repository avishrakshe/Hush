/**
 * P2 end-to-end proof on Fuji, using the official eERC SDK headlessly:
 *
 *   register (auditor, owner, Veil, provider)   →  deployer (the eERC owner) sets the auditor
 *   owner deposits USDC → encrypted hUSDC       (public amount: converter deposits are ERC-20 transfers)
 *   owner → Veil private transfer               (treasury allocation — amount hidden)
 *   Veil  → provider private top-up + metadata  (the hush-credit top-up — amount hidden)
 *   receiver decrypts each amount from calldata, provider decrypts the metadata, auditor decrypts everything.
 *
 * Usage: pnpm prove:fuji
 */
// The SDK's package.json "main" points to a dist/index.cjs that isn't published; the ESM build is the real entry.
import { EERC } from "@avalabs/eerc-sdk/dist/index.js";
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  formatUnits,
  http,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji, hardhat } from "viem/chains";
import { NET, NETWORK, type Role, addrLink, circuitPaths, loadAbi, loadDeployment, roleKey, txLink } from "./lib/env.mjs";

const chain = NETWORK === "fuji" ? avalancheFuji : hardhat;
const d = loadDeployment();
const EERC_ADDRESS = d.contracts.EncryptedERC.address as Address;
const REGISTRAR = d.contracts.Registrar.address as Address;
const USDC = d.contracts.MockUSDC.address as Address;
const DECIMALS = d.eercDecimals;

const eercAbi = loadAbi("contracts/eerc/EncryptedERC.sol/EncryptedERC.json") as Abi;
const registrarAbi = loadAbi("contracts/eerc/Registrar.sol/Registrar.json") as Abi;
const usdcAbi = loadAbi("contracts/token/MockUSDC.sol/MockUSDC.json") as Abi;

// Transfer proof public-signal layout (EncryptedERC._executePrivateTransfer / transfer.circom).
const RECEIVER_PCT = [16, 23] as const; // receiver's Poseidon ciphertext of the amount (circuit-constrained)
const AUDITOR_PCT = [25, 32] as const; // auditor's Poseidon ciphertext of the amount

const publicClient = createPublicClient({ chain, transport: http(NET.rpc) });
const circuits = circuitPaths();

const hUSDC = (units: bigint) => `${formatUnits(units, DECIMALS)} hUSDC`;
const log = (msg = "") => console.log(msg);
const step = (n: number, title: string) => log(`\n── ${n}. ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
const summary: { step: string; tx: string }[] = [];

function actor(role: Role) {
  const account = privateKeyToAccount(roleKey(role));
  const wallet = createWalletClient({ account, chain, transport: http(NET.rpc) });
  // Converter mode (isConverter = true): hUSDC wraps an existing ERC-20.
  const eerc = new EERC(publicClient, wallet, EERC_ADDRESS, REGISTRAR, true, circuits);
  return { role, address: account.address, wallet, eerc };
}
type Actor = ReturnType<typeof actor>;

async function waitOk(hash: Hex, label: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${txLink(hash)}`);
  summary.push({ step: label, tx: txLink(hash) });
  return receipt;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, string]> {
  const t0 = performance.now();
  const out = await fn();
  return [out, `${((performance.now() - t0) / 1000).toFixed(1)}s`];
}

/** Registers the actor in eERC (Groth16 registration proof) or, if already registered, re-derives its key. */
async function ensureRegistered(a: Actor) {
  const registered = (await publicClient.readContract({
    address: REGISTRAR,
    abi: registrarAbi,
    functionName: "isUserRegistered",
    args: [a.address],
  })) as boolean;
  if (registered) {
    await a.eerc.generateDecryptionKey(); // deterministic: same wallet signature → same BabyJubJub key
    log(`  ${a.role.padEnd(9)} already registered ${a.address}`);
    return;
  }
  const [{ transactionHash }, took] = await timed(() => a.eerc.register());
  await waitOk(transactionHash as Hex, `register ${a.role}`);
  log(`  ${a.role.padEnd(9)} registered (proof+tx ${took})  ${txLink(transactionHash)}`);
}

async function auditorPublicKey(): Promise<bigint[]> {
  const [x, y] = (await publicClient.readContract({ address: EERC_ADDRESS, abi: eercAbi, functionName: "auditorPublicKey" })) as [bigint, bigint];
  return [x, y];
}

/** Reads the actor's encrypted hUSDC balance and decrypts it locally with the actor's key. */
async function balanceOf(a: Actor) {
  const [eGCT, , amountPCTs, balancePCT] = (await publicClient.readContract({
    address: EERC_ADDRESS,
    abi: eercAbi,
    functionName: "getBalanceFromTokenAddress",
    args: [a.address, USDC],
  })) as [
    { c1: { x: bigint; y: bigint }; c2: { x: bigint; y: bigint } },
    bigint,
    { pct: readonly bigint[]; index: bigint }[],
    readonly bigint[],
    bigint,
  ];
  const decrypted = a.eerc.calculateTotalBalance(
    eGCT,
    amountPCTs.map((p) => ({ index: p.index, pct: [...p.pct] })),
    [...balancePCT],
  );
  if (decrypted < 0n) throw new Error(`${a.role}: balance PCTs out of sync with the ElGamal ciphertext`);
  return { encrypted: [eGCT.c1.x, eGCT.c1.y, eGCT.c2.x, eGCT.c2.y], decrypted };
}

/** Pulls the transfer proof's public signals out of the transaction calldata. */
async function transferSignals(hash: Hex): Promise<readonly bigint[]> {
  const tx = await publicClient.getTransaction({ hash });
  const { functionName, args } = decodeFunctionData({ abi: eercAbi, data: tx.input });
  if (functionName !== "transfer" || !args) throw new Error(`${hash} is not an eERC transfer`);
  return (args[2] as { publicSignals: readonly bigint[] }).publicSignals;
}

/** What the facilitator will do for every top-up: decrypt the receiver PCT straight from calldata. */
async function receiverDecrypts(receiver: Actor, hash: Hex) {
  const signals = await transferSignals(hash);
  return receiver.eerc.decryptPCT([...signals.slice(...RECEIVER_PCT)]);
}

async function auditorDecrypts(auditor: Actor, hash: Hex) {
  const receipt = await publicClient.getTransactionReceipt({ hash });
  const [ev] = parseEventLogs({ abi: eercAbi, eventName: "PrivateTransfer", logs: receipt.logs }) as unknown as {
    args: { from: Address; to: Address; auditorPCT: readonly bigint[] };
  }[];
  if (!ev) throw new Error(`no PrivateTransfer event in ${hash}`);
  return { ...ev.args, amount: auditor.eerc.decryptPCT([...ev.args.auditorPCT]) };
}

const short = (v: bigint) => `0x${v.toString(16).slice(0, 10)}…`;

async function main() {
  const deployer = actor("DEPLOYER");
  const auditor = actor("AUDITOR");
  const owner = actor("OWNER");
  const veil = actor("VEIL");
  const provider = actor("PROVIDER");

  log(`Network ${NETWORK} (chainId ${NET.chainId})`);
  log(`eERC converter ${addrLink(EERC_ADDRESS)}`);
  log(`MockUSDC       ${addrLink(USDC)}`);

  step(1, "Register eERC keys (client-side Groth16 registration proofs)");
  for (const a of [auditor, owner, veil, provider]) await ensureRegistered(a);

  step(2, "Set the auditor (eERC owner only; required before any transfer)");
  const currentAuditor = (await publicClient.readContract({ address: EERC_ADDRESS, abi: eercAbi, functionName: "auditor" })) as Address;
  if (currentAuditor.toLowerCase() !== auditor.address.toLowerCase()) {
    const hash = await deployer.wallet.writeContract({ address: EERC_ADDRESS, abi: eercAbi, functionName: "setAuditorPublicKey", args: [auditor.address] });
    await waitOk(hash, "setAuditorPublicKey");
    log(`  auditor set to ${auditor.address}  ${txLink(hash)}`);
  } else log(`  auditor already ${auditor.address}`);
  const auditorPK = await auditorPublicKey();

  step(3, "Owner deposits 50 USDC → encrypted hUSDC (converter mode)");
  const depositAmount = 50_000_000n; // 50 USDC (6 decimals)
  let hash = await owner.wallet.writeContract({ address: USDC, abi: usdcAbi, functionName: "mint", args: [owner.address, depositAmount] });
  await waitOk(hash, "mint MockUSDC");
  hash = await owner.wallet.writeContract({ address: USDC, abi: usdcAbi, functionName: "approve", args: [EERC_ADDRESS, depositAmount] });
  await waitOk(hash, "approve eERC");
  const { transactionHash: depositHash } = await owner.eerc.deposit(depositAmount, USDC, BigInt(DECIMALS));
  await waitOk(depositHash, "deposit (public amount)");
  let ownerBal = await balanceOf(owner);
  log(`  deposit ${txLink(depositHash)}`);
  log(`  owner decrypts own balance: ${hUSDC(ownerBal.decrypted)}   (on-chain: ElGamal ${short(ownerBal.encrypted[0]!)})`);

  step(4, "Owner → Veil: private treasury allocation (20.00 hUSDC)");
  const allocation = 20n * 10n ** BigInt(DECIMALS);
  const [allocTx, allocTook] = await timed(() => owner.eerc.transfer(veil.address, allocation, ownerBal.encrypted, ownerBal.decrypted, auditorPK, USDC));
  await waitOk(allocTx.transactionHash, "owner → Veil private transfer");
  log(`  transfer (proof+tx ${allocTook})  ${txLink(allocTx.transactionHash)}`);
  log(`  Veil decrypts the incoming amount from calldata: ${hUSDC(await receiverDecrypts(veil, allocTx.transactionHash))}`);

  step(5, "Veil → provider: private top-up (5.00 hUSDC) with encrypted metadata");
  const veilBal = await balanceOf(veil);
  const topUp = 5n * 10n ** BigInt(DECIMALS);
  const note = `hush:topup:v1:agent=${veil.address.toLowerCase()}`;
  const [topTx, topTook] = await timed(() => veil.eerc.transfer(provider.address, topUp, veilBal.encrypted, veilBal.decrypted, auditorPK, USDC, note));
  await waitOk(topTx.transactionHash, "Veil → provider top-up");
  log(`  top-up (proof+tx ${topTook})  ${txLink(topTx.transactionHash)}`);

  step(6, "Provider (facilitator) decrypts the top-up — no plaintext ever touched the chain");
  const credited = await receiverDecrypts(provider, topTx.transactionHash);
  const meta = await provider.eerc.decryptMessage(topTx.transactionHash);
  log(`  amount   ${hUSDC(credited)}   ← receiver PCT = publicSignals[${RECEIVER_PCT[0]}..${RECEIVER_PCT[1] - 1}]`);
  log(`  metadata "${meta.decryptedMessage}" (${meta.messageType})`);
  if (credited !== topUp) throw new Error(`provider decrypted ${credited}, expected ${topUp}`);

  step(7, "Auditor decrypts both private transfers (compliance view)");
  for (const [label, h] of [["owner → Veil", allocTx.transactionHash], ["Veil → provider", topTx.transactionHash]] as const) {
    const a = await auditorDecrypts(auditor, h);
    log(`  ${label.padEnd(16)} ${hUSDC(a.amount)}   (${a.from.slice(0, 8)}… → ${a.to.slice(0, 8)}…)`);
  }

  step(8, "Final balances — each decrypted only by its own key");
  ownerBal = await balanceOf(owner);
  for (const [a, b] of [[owner, ownerBal], [veil, await balanceOf(veil)], [provider, await balanceOf(provider)]] as const) {
    log(`  ${a.role.padEnd(9)} ${hUSDC(b.decrypted).padEnd(16)} public sees only ElGamal ${short(b.encrypted[0]!)} / ${short(b.encrypted[2]!)}`);
  }

  log("\nWhat an observer sees for the top-up: sender + receiver addresses, a proof and ciphertexts — no amount.");
  console.table(summary);
}

main()
  .then(() => process.exit(0)) // snarkjs keeps worker threads alive; exit explicitly
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
