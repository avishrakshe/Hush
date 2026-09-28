/**
 * Shared runtime config for Hush Node apps (facilitator, provider-demo, agents, MCP, scripts).
 * Everything comes from the repo-root .env plus packages/contracts/deployments/<network>.json.
 *
 *   HUSH_NETWORK=fuji (default) | localhost
 */
import { type CircuitURLs, EercAccount, type HushContracts } from "@hush/x402";
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
  return {
    chainId: d.chainId,
    eercDecimals: d.eercDecimals,
    startBlock: c("EncryptedERC").blockNumber,
    encryptedErc: c("EncryptedERC").address,
    registrar: c("Registrar").address,
    usdc: c("MockUSDC").address,
    hushRegistry: c("HushRegistry").address,
    hushLedger: c("HushLedger").address,
  };
}

/** Local file paths to the prebuilt eERC circuits (they match the prod verifiers on-chain). */
export function circuitPaths(): CircuitURLs {
  const c = (...p: string[]) => path.join(REPO_ROOT, "packages", "contracts", "circuits", ...p);
  return {
    register: { wasm: c("registration", "registration.wasm"), zkey: c("registration", "circuit_final.zkey") },
    transfer: { wasm: c("transfer", "transfer.wasm"), zkey: c("transfer", "transfer.zkey") },
    withdraw: { wasm: c("withdraw", "withdraw.wasm"), zkey: c("withdraw", "circuit_final.zkey") },
    mint: { wasm: "", zkey: "" },
    burn: { wasm: "", zkey: "" },
  };
}

export const ROLES = ["DEPLOYER", "AUDITOR", "OWNER", "ATLAS", "VEIL", "PROVIDER", "FACILITATOR"] as const;
export type Role = (typeof ROLES)[number];

export function roleKey(role: Role): Hex {
  const v = process.env[`${role}_PRIVATE_KEY`]?.trim();
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${role}_PRIVATE_KEY missing in .env — run \`pnpm keys\``);
  return v as Hex;
}

export const publicClient = createPublicClient({ chain: NET.chain, transport: http(NET.rpc) });

/** Account, wallet client and (lazily initialised) eERC account for a role. */
export function wallet(role: Role) {
  const account = privateKeyToAccount(roleKey(role));
  const walletClient = createWalletClient({ account, chain: NET.chain, transport: http(NET.rpc) });
  let eerc: EercAccount | undefined;
  return {
    role,
    account,
    address: account.address,
    walletClient,
    /** eERC account for this wallet (key derived from a wallet signature on first use). */
    eerc(contracts: HushContracts = loadContracts()): EercAccount {
      eerc ??= new EercAccount({ publicClient: publicClient as never, walletClient, contracts, circuits: circuitPaths() });
      return eerc;
    },
  };
}
