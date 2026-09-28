/**
 * Fuji: forwards a little AVAX from the DEPLOYER to every other role that is running low, so only one
 *       address ever needs the faucet.
 * localhost (HUSH_NETWORK=localhost): sets every role's balance directly on the hardhat node.
 */
import { JsonRpcProvider, Wallet, formatEther, parseEther, toQuantity } from "ethers";
import { NET, NETWORK, ROLES, roleKey, txLink } from "./lib/env.mjs";

const provider = new JsonRpcProvider(NET.rpc, NET.chainId, { staticNetwork: true });
const roles = ROLES.map((role) => ({ role, address: new Wallet(roleKey(role)).address }));

if (NETWORK === "localhost") {
  for (const r of roles) await provider.send("hardhat_setBalance", [r.address, toQuantity(parseEther("100"))]);
  console.log("localhost: set every role to 100 ETH");
} else {
  const deployer = new Wallet(roleKey("DEPLOYER"), provider);
  const amount = parseEther(process.env.FUND_AMOUNT_AVAX || "0.05");
  const targets = roles.filter((r) => r.role !== "DEPLOYER");
  const balances = await Promise.all(targets.map((t) => provider.getBalance(t.address)));
  const needy = targets.filter((_, i) => balances[i]! < amount / 2n);

  const deployerBalance = await provider.getBalance(deployer.address);
  console.log(`Deployer ${deployer.address}: ${formatEther(deployerBalance)} AVAX`);
  const required = amount * BigInt(needy.length) + parseEther("0.01");
  if (deployerBalance < required) {
    throw new Error(
      `Deployer needs ~${formatEther(required)} AVAX to fund ${needy.length} roles ` +
        `(lower FUND_AMOUNT_AVAX in .env or top up from the faucet).`,
    );
  }
  for (const t of needy) {
    const tx = await deployer.sendTransaction({ to: t.address, value: amount });
    await tx.wait();
    console.log(`  funded ${t.role.padEnd(11)} ${t.address} +${formatEther(amount)} AVAX  ${txLink(tx.hash)}`);
  }
  if (needy.length === 0) console.log("  every role already has AVAX");
}

const after = await Promise.all(roles.map((r) => provider.getBalance(r.address)));
console.table(roles.map((r, i) => ({ role: r.role, address: r.address, balance: formatEther(after[i]!) })));
