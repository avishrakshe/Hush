import type { ProofSnapshot } from "@/lib/proof";
import { HUSH_DEPLOYMENTS, encryptedErcAbi, hushLedgerAbi, hushRegistryAbi, mockUsdcAbi } from "@hush/x402/contracts";
import { type Address, createPublicClient, formatUnits, http, toHex } from "viem";
import { avalancheFuji } from "viem/chains";

/**
 * GET /api/proof — live, read-only snapshot of the Fuji deployment for the landing page's PROOF chapter.
 * View calls only (no log scans: the public RPC caps getLogs ranges), batched into multicalls.
 */
export const dynamic = "force-dynamic";

const FUJI = HUSH_DEPLOYMENTS[avalancheFuji.id]!;
const client = createPublicClient({
  chain: avalancheFuji,
  transport: http(process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc"),
  batch: { multicall: true },
});

const TTL_MS = 20_000;
const ROOTS_SHOWN = 4;
let cached: { at: number; body: ProofSnapshot } | undefined;
let inflight: Promise<ProofSnapshot> | undefined;

export async function GET() {
  try {
    if (!cached || Date.now() - cached.at > TTL_MS) {
      inflight ??= snapshot().finally(() => (inflight = undefined));
      cached = { at: Date.now(), body: await inflight };
    }
    return Response.json(cached.body, {
      headers: { "cache-control": "public, max-age=10, s-maxage=20, stale-while-revalidate=120" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : "RPC error";
    return Response.json({ error: `Fuji RPC unavailable: ${message}` }, { status: 502 });
  }
}

const pointHex = (p: { x: bigint; y: bigint }): [string, string] => [toHex(p.x, { size: 32 }), toHex(p.y, { size: 32 })];

async function snapshot(): Promise<ProofSnapshot> {
  const [blockNumber, providers, auditor, auditorKeySet, locked] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({ address: FUJI.hushRegistry, abi: hushRegistryAbi, functionName: "getProviders" }),
    client.readContract({ address: FUJI.encryptedErc, abi: encryptedErcAbi, functionName: "auditor" }),
    client.readContract({ address: FUJI.encryptedErc, abi: encryptedErcAbi, functionName: "isAuditorKeySet" }),
    client.readContract({ address: FUJI.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [FUJI.encryptedErc] }),
  ]);

  const rows = await Promise.all(
    providers.map(async (provider: Address) => {
      const [info, latest, balance] = await Promise.all([
        client.readContract({ address: FUJI.hushRegistry, abi: hushRegistryAbi, functionName: "getProvider", args: [provider] }),
        client.readContract({ address: FUJI.hushLedger, abi: hushLedgerAbi, functionName: "latestBatchId", args: [provider] }),
        client.readContract({
          address: FUJI.encryptedErc,
          abi: encryptedErcAbi,
          functionName: "getBalanceFromTokenAddress",
          args: [provider, FUJI.usdc],
        }),
      ]);
      const ids: bigint[] = [];
      for (let id = latest; id > 0n && ids.length < ROOTS_SHOWN; id--) ids.push(id);
      const roots = await Promise.all(
        ids.map((id) => client.readContract({ address: FUJI.hushLedger, abi: hushLedgerAbi, functionName: "getRoot", args: [provider, id] })),
      );
      const [eGCT] = balance;
      return {
        address: provider,
        name: info.name,
        endpoint: info.endpoint,
        pricePerCall: formatUnits(info.pricePerCall, 6),
        facilitator: info.facilitator,
        flagCount: Number(info.flagCount),
        latestBatchId: latest.toString(),
        roots: ids.map((id, i) => ({ batchId: id.toString(), root: roots[i]! })),
        encryptedBalance: { c1: pointHex(eGCT.c1), c2: pointHex(eGCT.c2) },
      };
    }),
  );

  return {
    chainId: avalancheFuji.id,
    blockNumber: blockNumber.toString(),
    fetchedAt: Date.now(),
    contracts: [
      { name: "EncryptedERC", role: "eERC converter · encrypted balances, Groth16-verified transfers", address: FUJI.encryptedErc },
      { name: "Registrar", role: "eERC BabyJubJub public keys", address: FUJI.registrar },
      { name: "HushRegistry", role: "providers · agents · owner kill switch · flags", address: FUJI.hushRegistry },
      { name: "HushLedger", role: "Merkle batch roots · EIP-712 voucher domain", address: FUJI.hushLedger },
      { name: "MockUSDC", role: "EIP-3009 test USDC (wrapped by the converter)", address: FUJI.usdc },
    ],
    auditor: { address: auditor, keySet: auditorKeySet },
    lockedUsdc: formatUnits(locked, 6),
    providers: rows,
  };
}
