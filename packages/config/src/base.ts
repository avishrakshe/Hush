/**
 * Light half of @hush/config: network, deployment, role keys and viem clients — no eERC SDK / snarkjs (which costs a
 * process ~150 MB just to import). For viem-only services such as the price bot and Mirror:
 *
 *   import { NETWORK, loadContracts, publicClient, signer } from "@hush/config/base";
 *
 * Everything here is re-exported by "@hush/config", which adds the eERC-aware `wallet()`.
 *   HUSH_NETWORK=fuji (default) | localhost
 */
import { type HushContracts, STOCK_TICKERS, type StockTicker } from "@hush/x402/contracts";
import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Chain, type Hex, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji, hardhat } from "viem/chains";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
loadDotenv({ path: path.join(REPO_ROOT, ".env"), quiet: true });

export type NetworkName = "fuji" | "localhost";
export const NETWORK: NetworkName =
  process.env.HUSH_NETWORK === "localhost" || process.argv.includes("--local") ? "localhost" : "fuji";

const NETWORKS: Record<NetworkName, { chain: Chain; rpc: string; explorer?: string }> = {
  fuji: {
    chain: avalancheFuji,
    rpc: process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc",
    explorer: "https://testnet.snowtrace.io",
  },
  localhost: { chain: hardhat, rpc: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545" },
};
export const NET = NETWORKS[NETWORK];
export const txLink = (hash: string) => (NET.explorer ? `${NET.explorer}/tx/${hash}` : hash);
export const addrLink = (address: string) => (NET.explorer ? `${NET.explorer}/address/${address}` : address);

/** Service endpoints (override with env for deployed setups). */
export const PORTS = {
  facilitator: Number(process.env.FACILITATOR_PORT || 4022),
  provider: Number(process.env.PROVIDER_PORT || 4021),
};
export const URLS = {
  facilitator: process.env.FACILITATOR_URL || `http://localhost:${PORTS.facilitator}`,
  provider: process.env.PROVIDER_URL || `http://localhost:${PORTS.provider}`,
};

export function loadContracts(network: NetworkName = NETWORK): HushContracts {
  const file = path.join(REPO_ROOT, "packages", "contracts", "deployments", `${network}.json`);
  if (!existsSync(file)) throw new Error(`No ${network} deployment (${file}) — run \`pnpm deploy:${network === "localhost" ? "local" : "fuji"}\``);
  const d = JSON.parse(readFileSync(file, "utf8")) as {
    chainId: number;
    eercDecimals: number;
    contracts: Record<string, { address: `0x${string}`; blockNumber: number }>;
  };
  const c = (name: string) => {
    const entry = d.contracts[name];
    if (!entry) throw new Error(`deployment is missing ${name}`);
    return entry;
  };
  // v2 stocks are optional: a v1-only deployment still loads (apps that need them check `stockOracle`).
  const stocks: Partial<Record<StockTicker, `0x${string}`>> = {};
  for (const t of STOCK_TICKERS) {
    const entry = d.contracts[`m${t}`];
    if (entry) stocks[t] = entry.address;
  }
  return {
    chainId: d.chainId,
    eercDecimals: d.eercDecimals,
    startBlock: c("EncryptedERC").blockNumber,
    encryptedErc: c("EncryptedERC").address,
    registrar: c("Registrar").address,
    usdc: c("MockUSDC").address,
    hushRegistry: c("HushRegistry").address,
    hushLedger: c("HushLedger").address,
    ...(d.contracts.MockStockOracle && { stockOracle: d.contracts.MockStockOracle.address, stocks }),
  };
}

// v1 roles first; DESK (market maker), ALPHAKING (dishonest signal provider), MIRROR (copycat bot) and PRICEBOT
// (oracle updater) were added for v2.
export const ROLES = ["DEPLOYER", "AUDITOR", "OWNER", "ATLAS", "VEIL", "PROVIDER", "FACILITATOR", "DESK", "ALPHAKING", "MIRROR", "PRICEBOT"] as const;
export type Role = (typeof ROLES)[number];

export function roleKey(role: Role): Hex {
  const v = process.env[`${role}_PRIVATE_KEY`]?.trim();
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${role}_PRIVATE_KEY missing in .env — run \`pnpm keys\``);
  return v as Hex;
}

export const publicClient = createPublicClient({ chain: NET.chain, transport: http(NET.rpc) });

/** Account + wallet client for a role (no eERC). `@hush/config`'s `wallet()` adds the eERC account. */
export function signer(role: Role) {
  const account = privateKeyToAccount(roleKey(role));
  const walletClient = createWalletClient({ account, chain: NET.chain, transport: http(NET.rpc) });
  return { role, account, address: account.address, walletClient };
}
