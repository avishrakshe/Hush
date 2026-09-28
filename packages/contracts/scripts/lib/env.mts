import { config } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HushDeployment } from "./types.js";

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const CONTRACTS_DIR = fileURLToPath(new URL("../../", import.meta.url));
export const ENV_PATH = path.join(REPO_ROOT, ".env");

config({ path: ENV_PATH, quiet: true });

export const ROLES = ["DEPLOYER", "AUDITOR", "OWNER", "ATLAS", "VEIL", "PROVIDER", "FACILITATOR"] as const;
export type Role = (typeof ROLES)[number];

/** Which chain the .mts scripts target. `localhost` = a `hardhat node` for fully offline dry runs. */
export type NetworkName = "fuji" | "localhost";
export const NETWORK: NetworkName =
  process.env.HUSH_NETWORK === "localhost" || process.argv.includes("--local") ? "localhost" : "fuji";

const NETWORKS: Record<NetworkName, { chainId: number; rpc: string; explorer?: string }> = {
  fuji: {
    chainId: 43113,
    rpc: process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc",
    explorer: "https://testnet.snowtrace.io",
  },
  localhost: { chainId: 31337, rpc: "http://127.0.0.1:8545" },
};
export const NET = NETWORKS[NETWORK];

export const txLink = (hash: string) => (NET.explorer ? `${NET.explorer}/tx/${hash}` : hash);
export const addrLink = (address: string) => (NET.explorer ? `${NET.explorer}/address/${address}` : address);

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
export const isPrivateKey = (value: string | undefined): value is `0x${string}` => !!value && KEY_RE.test(value.trim());

export function roleKey(role: Role): `0x${string}` {
  const value = process.env[`${role}_PRIVATE_KEY`]?.trim();
  if (!isPrivateKey(value)) throw new Error(`${role}_PRIVATE_KEY is missing or malformed in ${ENV_PATH} — run \`pnpm keys\``);
  return value;
}

export function loadDeployment(network: string = NETWORK): HushDeployment {
  const file = path.join(CONTRACTS_DIR, "deployments", `${network}.json`);
  if (!existsSync(file)) throw new Error(`No deployment at ${file} — run \`pnpm deploy:fuji\` first`);
  return JSON.parse(readFileSync(file, "utf8")) as HushDeployment;
}

export function loadAbi(artifactPath: string): readonly unknown[] {
  const file = path.join(CONTRACTS_DIR, "artifacts", artifactPath);
  if (!existsSync(file)) throw new Error(`Missing artifact ${file} — run \`pnpm compile\``);
  return (JSON.parse(readFileSync(file, "utf8")) as { abi: readonly unknown[] }).abi;
}

/** Local paths to the prebuilt eERC circuits (they match the prod verifiers deployed on-chain). */
export function circuitPaths() {
  const c = (...p: string[]) => path.join(CONTRACTS_DIR, "circuits", ...p);
  return {
    register: { wasm: c("registration", "registration.wasm"), zkey: c("registration", "circuit_final.zkey") },
    transfer: { wasm: c("transfer", "transfer.wasm"), zkey: c("transfer", "transfer.zkey") },
    withdraw: { wasm: c("withdraw", "withdraw.wasm"), zkey: c("withdraw", "circuit_final.zkey") },
    // Standalone-mode circuits — unused in converter mode, so not shipped.
    mint: { wasm: "", zkey: "" },
    burn: { wasm: "", zkey: "" },
  };
}
