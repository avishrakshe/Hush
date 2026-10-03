/**
 * Shared runtime config for Hush Node apps (facilitator, provider-demo, agents, MCP, scripts).
 * Everything comes from the repo-root .env plus packages/contracts/deployments/<network>.json.
 * viem-only services can import "@hush/config/base" instead and skip loading the eERC SDK.
 *
 *   HUSH_NETWORK=fuji (default) | localhost
 */
import { type CircuitURLs, EercAccount, type HushContracts } from "@hush/x402";
import path from "node:path";
import { REPO_ROOT, type Role, loadContracts, publicClient, signer } from "./base.js";

export * from "./base.js";

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

/** Account, wallet client and (lazily initialised) eERC account for a role. */
export function wallet(role: Role) {
  const base = signer(role);
  let eerc: EercAccount | undefined;
  return {
    ...base,
    /** eERC account for this wallet (key derived from a wallet signature on first use). */
    eerc(contracts: HushContracts = loadContracts()): EercAccount {
      eerc ??= new EercAccount({ publicClient: publicClient as never, walletClient: base.walletClient, contracts, circuits: circuitPaths() });
      return eerc;
    },
  };
}
