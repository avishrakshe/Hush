"use client";

import { FUJI_RPC } from "@/lib/services";
import { HUSH_DEPLOYMENTS, encryptedErcAbi, hushLedgerAbi, hushRegistryAbi, mockUsdcAbi } from "@hush/x402/contracts";
import { useEffect, useState } from "react";
import { type Address, type Hex, createPublicClient, http, isAddressEqual } from "viem";
import { avalancheFuji } from "viem/chains";

export const FUJI = HUSH_DEPLOYMENTS[avalancheFuji.id]!;
/** Browser Fuji client. `batch` folds each poll's concurrent calls into one JSON-RPC request. */
export const fuji = createPublicClient({ chain: avalancheFuji, transport: http(FUJI_RPC, { batch: true }) });

export type ChainKind = "payment" | "topup" | "allocation" | "refund" | "transfer" | "batch" | "frozen" | "unfrozen";

/** One on-chain event, exactly as any observer can read it. */
export interface ChainRow {
  key: string;
  kind: ChainKind;
  txHash: Hex;
  block: bigint;
  at: number;
  from?: Address;
  to?: Address;
  /** Only public payments carry a readable amount. */
  value?: bigint;
  batchId?: bigint;
  root?: Hex;
}

export interface FeedTargets {
  atlas: Address;
  veil: Address;
  provider: Address;
  owner?: Address;
}

export interface ChainFeed {
  atlas: ChainRow[];
  veil: ChainRow[];
  batches: ChainRow[];
  block?: bigint;
  since?: number;
  error?: string;
}

const POLL_MS = 4_000;
/** ~1.5 h of Fuji blocks, and under the public RPC's 2048-block getLogs cap. */
const WINDOW = 1_900n;

export function useChainFeed(t: FeedTargets | null): ChainFeed {
  const [feed, setFeed] = useState<ChainFeed>({ atlas: [], veil: [], batches: [] });

  useEffect(() => {
    if (!t) return;
    let stopped = false;
    let next: bigint | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const times = new Map<bigint, number>();
    const seen = new Set<string>();

    async function poll() {
      const latest = await fuji.getBlockNumber();
      const from = next ?? (latest > WINDOW ? latest - WINDOW : 0n);
      if (from > latest) {
        setFeed((f) => ({ ...f, block: latest, error: undefined }));
        return;
      }
      const range = { fromBlock: from, toBlock: latest };
      const [pays, veilOut, veilIn, batches, frozen, unfrozen] = await Promise.all([
        fuji.getContractEvents({ address: FUJI.usdc, abi: mockUsdcAbi, eventName: "Transfer", args: { from: t!.atlas }, ...range }),
        fuji.getContractEvents({ address: FUJI.encryptedErc, abi: encryptedErcAbi, eventName: "PrivateTransfer", args: { from: t!.veil }, ...range }),
        fuji.getContractEvents({ address: FUJI.encryptedErc, abi: encryptedErcAbi, eventName: "PrivateTransfer", args: { to: t!.veil }, ...range }),
        fuji.getContractEvents({ address: FUJI.hushLedger, abi: hushLedgerAbi, eventName: "BatchCommitted", args: { provider: t!.provider }, ...range }),
        fuji.getContractEvents({ address: FUJI.hushRegistry, abi: hushRegistryAbi, eventName: "AgentFrozen", ...range }),
        fuji.getContractEvents({ address: FUJI.hushRegistry, abi: hushRegistryAbi, eventName: "AgentUnfrozen", ...range }),
      ]);

      const blocks = new Set<bigint>();
      for (const l of [...pays, ...veilOut, ...veilIn, ...batches, ...frozen, ...unfrozen]) if (!times.has(l.blockNumber)) blocks.add(l.blockNumber);
      await Promise.all(
        [...blocks].map(async (b) => times.set(b, Number((await fuji.getBlock({ blockNumber: b })).timestamp) * 1000)),
      );

      const row = (l: { transactionHash: Hex; blockNumber: bigint; logIndex: number }, rest: Omit<ChainRow, "key" | "txHash" | "block" | "at">): ChainRow | null => {
        const key = `${l.transactionHash}:${l.logIndex}`;
        if (seen.has(key)) return null;
        seen.add(key);
        return { key, txHash: l.transactionHash, block: l.blockNumber, at: times.get(l.blockNumber) ?? Date.now(), ...rest };
      };
      const eq = (a?: Address, b?: Address) => !!a && !!b && isAddressEqual(a, b);

      const atlasRows = pays.map((l) => row(l, { kind: "payment", from: l.args.from, to: l.args.to, value: l.args.value }));
      const veilRows = [...veilOut, ...veilIn].map((l) => {
        const { from, to } = l.args as { from: Address; to: Address };
        const kind: ChainKind = eq(from, t!.veil)
          ? eq(to, t!.provider)
            ? "topup"
            : "transfer"
          : eq(from, t!.provider)
            ? "refund"
            : eq(from, t!.owner)
              ? "allocation"
              : "transfer";
        return row(l, { kind, from, to });
      });
      const killRows = [...frozen, ...unfrozen].map((l) => {
        const agent = (l.args as { agent: Address }).agent;
        return { agent, r: row(l, { kind: l.eventName === "AgentFrozen" ? "frozen" : "unfrozen", to: agent }) };
      });
      const batchRows = batches.map((l) => row(l, { kind: "batch", batchId: l.args.batchId, root: l.args.merkleRoot }));

      const add = (prev: ChainRow[], rows: (ChainRow | null)[]) =>
        [...prev, ...rows.filter((r): r is ChainRow => r !== null)].sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? 1 : -1)).slice(0, 400);

      next = latest + 1n;
      if (stopped) return;
      setFeed((f) => ({
        atlas: add(f.atlas, [...atlasRows, ...killRows.filter((k) => eq(k.agent, t!.atlas)).map((k) => k.r)]),
        veil: add(f.veil, [...veilRows, ...killRows.filter((k) => eq(k.agent, t!.veil)).map((k) => k.r)]),
        batches: add(f.batches, batchRows),
        block: latest,
        since: f.since ?? times.get(from) ?? Date.now(),
        error: undefined,
      }));
    }

    const loop = async () => {
      try {
        await poll();
      } catch (err) {
        if (!stopped) setFeed((f) => ({ ...f, error: (err as Error).message.split("\n")[0] }));
      }
      if (!stopped) timer = setTimeout(loop, POLL_MS);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [t?.atlas, t?.veil, t?.provider, t?.owner]);

  return feed;
}
