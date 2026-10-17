import { HUSH_DEPLOYMENTS, type HushContracts } from "@hush/x402/contracts";
import { type PublicClient, createPublicClient, http } from "viem";
import { avalancheFuji, hardhat } from "viem/chains";
import { FUJI_RPC, LOCAL_RPC } from "./services";

export const FUJI_CONTRACTS = HUSH_DEPLOYMENTS[avalancheFuji.id]!;

const clients = new Map<number, PublicClient>();
/**
 * Browser client for the chain the demo stack runs on: Fuji, or a local hardhat node (`pnpm demo --local`).
 * `batch` folds each poll's concurrent calls into one JSON-RPC request.
 */
export function clientFor(chainId: number): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    const local = chainId === hardhat.id;
    c = createPublicClient({ chain: local ? hardhat : avalancheFuji, transport: http(local ? LOCAL_RPC : FUJI_RPC, { batch: true }) }) as PublicClient;
    clients.set(chainId, c);
  }
  return c;
}

export const isLocal = (c: Pick<HushContracts, "chainId">) => c.chainId === hardhat.id;
