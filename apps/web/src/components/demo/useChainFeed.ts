"use client";

import { clientFor } from "@/lib/net";
import { type HushContracts, STOCK_TICKERS, encryptedErcAbi, hushLedgerAbi, hushRegistryAbi, mockUsdcAbi } from "@hush/x402/contracts";
import { useEffect, useState } from "react";
import { type Address, type Hex, isAddressEqual, parseAbiItem } from "viem";
import type { FeedTargets } from "./useStack";

export type { FeedTargets } from "./useStack";

export type ChainKind =
  | "signal-payment"
  | "trade-payment"
  | "payment"
  | "proceeds"
  | "delivery"
  | "stock-sale"
  | "topup"
  | "allocation"
  | "refund"
  | "settle-out"
  | "transfer"
  | "batch"
  | "frozen"
  | "unfrozen";

/** One on-chain event, exactly as any observer can read it. */
export interface ChainRow {
  key: string;
  kind: ChainKind;
  txHash: Hex;
  block: bigint;
  at: number;
  from?: Address;
  to?: Address;
  /** Public USDC amount (atomic). Encrypted transfers have none. */
  value?: bigint;
  /** Public mStock movement: ticker + size (18-dp token units). */
  ticker?: string;
  shares?: bigint;
  batchId?: bigint;
  root?: Hex;
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
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export function useChainFeed(t: FeedTargets | null, contracts: HushContracts): ChainFeed {
  const [feed, setFeed] = useState<ChainFeed>({ atlas: [], veil: [], batches: [] });

  useEffect(() => {
    if (!t) return;
    setFeed({ atlas: [], veil: [], batches: [] });
    const client = clientFor(contracts.chainId);
    let stopped = false;
    let next: bigint | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const times = new Map<bigint, number>();
    const seen = new Set<string>();
    const stocks = STOCK_TICKERS.flatMap((k) => (contracts.stocks?.[k] ? [[contracts.stocks[k]!, k] as const] : []));
    const tickerOf = (token: Address) => stocks.find(([a]) => isAddressEqual(a, token))?.[1];
    const eq = (a?: Address, b?: Address) => !!a && !!b && isAddressEqual(a, b);
    const counterparties = [t.provider, t.desk, t.alphaking].filter((x): x is Address => !!x);

    async function poll() {
      const latest = await client.getBlockNumber();
      const from = next ?? (latest > WINDOW ? latest - WINDOW : 0n);
      if (from > latest) {
        setFeed((f) => ({ ...f, block: latest, error: undefined }));
        return;
      }
      const range = { fromBlock: from, toBlock: latest };
      const stockAddrs = stocks.map(([a]) => a);
      const [usdcOut, usdcIn, stockIn, stockOut, veilOut, veilIn, batches, frozen, unfrozen] = await Promise.all([
        client.getContractEvents({ address: contracts.usdc, abi: mockUsdcAbi, eventName: "Transfer", args: { from: t!.atlas }, ...range }),
        client.getContractEvents({ address: contracts.usdc, abi: mockUsdcAbi, eventName: "Transfer", args: { to: t!.atlas }, ...range }),
        stockAddrs.length ? client.getLogs({ address: stockAddrs, event: transferEvent, args: { to: t!.atlas }, ...range }) : Promise.resolve([]),
        stockAddrs.length ? client.getLogs({ address: stockAddrs, event: transferEvent, args: { from: t!.atlas }, ...range }) : Promise.resolve([]),
        client.getContractEvents({ address: contracts.encryptedErc, abi: encryptedErcAbi, eventName: "PrivateTransfer", args: { from: t!.veil }, ...range }),
        client.getContractEvents({ address: contracts.encryptedErc, abi: encryptedErcAbi, eventName: "PrivateTransfer", args: { to: t!.veil }, ...range }),
        client.getContractEvents({ address: contracts.hushLedger, abi: hushLedgerAbi, eventName: "BatchCommitted", args: { provider: counterparties }, ...range }),
        client.getContractEvents({ address: contracts.hushRegistry, abi: hushRegistryAbi, eventName: "AgentFrozen", ...range }),
        client.getContractEvents({ address: contracts.hushRegistry, abi: hushRegistryAbi, eventName: "AgentUnfrozen", ...range }),
      ]);

      const all = [...usdcOut, ...usdcIn, ...stockIn, ...stockOut, ...veilOut, ...veilIn, ...batches, ...frozen, ...unfrozen];
      const blocks = new Set<bigint>();
      for (const l of all) if (l.blockNumber !== null && !times.has(l.blockNumber)) blocks.add(l.blockNumber);
      await Promise.all([...blocks].map(async (b) => times.set(b, Number((await client.getBlock({ blockNumber: b })).timestamp) * 1000)));

      type LogLike = { transactionHash: Hex | null; blockNumber: bigint | null; logIndex: number | null };
      const row = (l: LogLike, rest: Omit<ChainRow, "key" | "txHash" | "block" | "at">): ChainRow | null => {
        const key = `${l.transactionHash}:${l.logIndex}`;
        if (seen.has(key) || !l.transactionHash || l.blockNumber === null) return null;
        seen.add(key);
        return { key, txHash: l.transactionHash, block: l.blockNumber, at: times.get(l.blockNumber) ?? Date.now(), ...rest };
      };

      const atlasRows = [
        ...usdcOut.map((l) => {
          const to = l.args.to;
          const kind: ChainKind = eq(to, t!.desk) ? "trade-payment" : eq(to, t!.provider) || eq(to, t!.alphaking) ? "signal-payment" : "payment";
          return row(l, { kind, from: l.args.from, to, value: l.args.value });
        }),
        ...usdcIn.filter((l) => eq(l.args.from, t!.desk)).map((l) => row(l, { kind: "proceeds", from: l.args.from, to: l.args.to, value: l.args.value })),
        ...stockIn.map((l) => row(l, { kind: "delivery", from: l.args.from, to: l.args.to, ticker: tickerOf(l.address), shares: l.args.value })),
        ...stockOut.map((l) => row(l, { kind: "stock-sale", from: l.args.from, to: l.args.to, ticker: tickerOf(l.address), shares: l.args.value })),
      ];
      const veilRows = [...veilOut, ...veilIn].map((l) => {
        const { from, to } = l.args as { from: Address; to: Address };
        const kind: ChainKind = eq(from, t!.veil)
          ? counterparties.some((c) => eq(to, c))
            ? "topup"
            : "transfer"
          : eq(from, t!.desk)
            ? "settle-out"
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
      const batchRows = batches.map((l) => row(l, { kind: "batch", from: l.args.provider, batchId: l.args.batchId, root: l.args.merkleRoot }));

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
  }, [t, contracts]);

  return feed;
}
