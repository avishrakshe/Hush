/**
 * Light half of @hush/config: network, deployment, role keys and viem clients — no eERC SDK / snarkjs (which costs a
 * process ~150 MB just to import). For viem-only services such as the price bot and Mirror:
 *
 *   import { NETWORK, loadContracts, publicClient, signer } from "@hush/config/base";
 *
 * Everything here is re-exported by "@hush/config", which adds the eERC-aware `wallet()`.
 *   HUSH_NETWORK=fuji (default) | localhost
 */
import { type HushContracts, MAX_LOG_RANGE, STOCK_TICKERS, type StockTicker } from "@hush/x402/contracts";
import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Chain, type Hex, createPublicClient, createWalletClient, http, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji, hardhat } from "viem/chains";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
loadDotenv({ path: path.join(REPO_ROOT, ".env"), quiet: true });

export type NetworkName = "fuji" | "localhost";
export const NETWORK: NetworkName =
  process.env.HUSH_NETWORK === "localhost" || process.argv.includes("--local") ? "localhost" : "fuji";

// Log scans may use their own RPC. No single public Fuji RPC does both jobs: the official one serves historical state
// (needed to decrypt outgoing eERC transfers) but caps getLogs at 100 blocks; publicnode allows 50 000-block spans but
// prunes old state. logsRpc + logsMaxRange describe the RPC used for scans (FUJI_LOGS_RPC_URL, LOGS_MAX_RANGE);
// unset, scans use the main RPC 100 blocks at a time — correct everywhere, just slower over long histories.
const NETWORKS: Record<NetworkName, { chain: Chain; rpc: string; logsRpc: string; logsMaxRange: bigint; explorer?: string }> = {
  fuji: {
    chain: avalancheFuji,
    rpc: process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc",
    logsRpc: process.env.FUJI_LOGS_RPC_URL || process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc",
    logsMaxRange: BigInt(process.env.LOGS_MAX_RANGE || MAX_LOG_RANGE),
    explorer: "https://testnet.snowtrace.io",
  },
  localhost: {
    chain: hardhat,
    rpc: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
    logsRpc: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
    logsMaxRange: 10_000n,
  },
};
export const NET = NETWORKS[NETWORK];
export const txLink = (hash: string) => (NET.explorer ? `${NET.explorer}/tx/${hash}` : hash);
export const addrLink = (address: string) => (NET.explorer ? `${NET.explorer}/address/${address}` : address);

/** Service endpoints (override with env for deployed setups). */
export const PORTS = {
  facilitator: Number(process.env.FACILITATOR_PORT || 4022),
  provider: Number(process.env.PROVIDER_PORT || 4021),
  /** v2: Hush Desk (quotes, custody, settle-outs) with its own in-process facilitator. */
  desk: Number(process.env.DESK_PORT || 4023),
  /** v2: AlphaKing, the cherry-picking signal provider (served by the provider-demo process). */
  alphaking: Number(process.env.ALPHAKING_PORT || 4025),
};
export const URLS = {
  facilitator: process.env.FACILITATOR_URL || `http://localhost:${PORTS.facilitator}`,
  provider: process.env.PROVIDER_URL || `http://localhost:${PORTS.provider}`,
  desk: process.env.DESK_URL || `http://localhost:${PORTS.desk}`,
  alphaking: process.env.ALPHAKING_URL || `http://localhost:${PORTS.alphaking}`,
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
    ...(d.contracts.HushAlpha && { hushAlpha: d.contracts.HushAlpha.address }),
  };
}

// v1 roles first; DESK (market maker), ALPHAKING (dishonest signal provider), MIRROR (copycat bot), PRICEBOT
// (oracle updater) and COMMITTER (Proof of Alpha chain heads; its own key so commits never race a provider's nonces)
// were added for v2.
export const ROLES = ["DEPLOYER", "AUDITOR", "OWNER", "ATLAS", "VEIL", "PROVIDER", "FACILITATOR", "DESK", "ALPHAKING", "MIRROR", "PRICEBOT", "COMMITTER"] as const;
export type Role = (typeof ROLES)[number];

export function roleKey(role: Role): Hex {
  const v = process.env[`${role}_PRIVATE_KEY`]?.trim();
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${role}_PRIVATE_KEY missing in .env — run \`pnpm keys\``);
  return v as Hex;
}

export const publicClient = createPublicClient({ chain: NET.chain, transport: http(NET.rpc) });
/** For getLogs scans only: pair it with `NET.logsMaxRange` (see NETWORKS). Same RPC as publicClient unless configured. */
export const logsClient = NET.logsRpc === NET.rpc ? publicClient : createPublicClient({ chain: NET.chain, transport: http(NET.logsRpc) });

let stateTagCache: Promise<string> | undefined;
/**
 * Suffix for local state files (facilitator/desk SQLite, agent ledgers). A fresh `pnpm node` reuses every contract
 * address (same deployer, same nonces) on an empty chain, so files named only by network would carry stale credit,
 * batches and statements into it. Locally the tag is the genesis block hash — each chain gets its own files. Fuji: "".
 */
export function stateTag(): Promise<string> {
  stateTagCache ??=
    NETWORK === "localhost" ? publicClient.getBlock({ blockNumber: 0n }).then((b) => `-${(b.hash ?? "0x0").slice(2, 10)}`) : Promise.resolve("");
  return stateTagCache;
}

/**
 * Account + wallet client for a role (no eERC). `@hush/config`'s `wallet()` adds the eERC account.
 * `managedNonce`: assign nonces locally (viem's shared nonceManager) for processes that send several transactions from
 * one key concurrently — e.g. the desk commits batches, settles `exact` payments and delivers tokens with one wallet.
 */
export function signer(role: Role, opts: { managedNonce?: boolean } = {}) {
  const account = privateKeyToAccount(roleKey(role), opts.managedNonce ? { nonceManager } : undefined);
  const walletClient = createWalletClient({ account, chain: NET.chain, transport: http(NET.rpc) });
  return { role, account, address: account.address, walletClient };
}
