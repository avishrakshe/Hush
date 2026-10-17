"use client";

import { type AgentId, SERVICES, getJson, operator } from "@/lib/services";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Decrypted } from "./Observer";
import type { ChainRow } from "./useChainFeed";
import type { Viewer } from "./useTelemetry";

/** Polls `fn` every `ms`; keeps the last good value. */
export function usePoll<T>(fn: () => Promise<T | null>, ms: number, deps: unknown[] = []): T | null {
  const [value, setValue] = useState<T | null>(null);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const v = await ref.current().catch(() => null);
      if (!stopped) {
        setValue((prev) => v ?? prev);
        timer = setTimeout(tick, ms);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
  return value;
}

// ─── Mirror ───
export interface MirrorTarget {
  address: string;
  label: string;
  kind: "public" | "private" | "unknown";
  tradesSeen: number;
  tradesCopied: number;
  avgLagSec: number | null;
  targetPnlUsd: string | null;
  copiedPnlUsd: string;
  verdict: string;
  sees: string[];
}
export interface MirrorEvent {
  id: number;
  at: number;
  type: string;
  target?: string;
  kind?: string;
  ticker?: string;
  side?: string;
  shares?: string;
  price?: string;
  lagSec?: number;
  what?: string;
  amount?: string;
  reason?: string;
  error?: string;
  tx?: string;
}
export interface MirrorState {
  mirror: string;
  totals: { tradesCopied: number; avgLagSec: number | null; copiedPnlUsd: string };
  targets: MirrorTarget[];
  recent: MirrorEvent[];
  marks: Record<string, string>;
}

export const useMirror = () => usePoll(() => getJson<MirrorState>(`${SERVICES.mirror}/state`), 3_000);

// ─── agent state (positions, last decision) ───
export interface AgentState {
  ticker?: string;
  markUsd?: string;
  cashUsd?: string;
  position?: { shares: string; maxShares: string; avgCostUsd: string | null; unrealizedPnlUsd: string | null };
  lastDecision?: { action: string; shares?: string; rationale: string; brain: string };
  budget?: { dataSpentTodayUsd: string; dataDailyCapUsd: string; tradedTodayUsd: string; tradeDailyCapUsd: string };
  lastSignal?: { direction: string; confidence: number; priceUsd: number; ageSeconds: number } | null;
  sealed?: unknown;
}

/** Atlas's state is public at its /state. Veil's is sealed there — readable only through the operator as owner/auditor. */
export function useAgentState(agent: AgentId, viewer: Viewer) {
  return usePoll<{ state: AgentState | null; sealed: boolean }>(
    async () => {
      const raw = await getJson<AgentState>(`${SERVICES[agent]}/state`);
      if (!raw) return { state: null, sealed: false };
      if (!raw.sealed) return { state: raw, sealed: false };
      if (viewer === "raw") return { state: null, sealed: true };
      return { state: await operator<AgentState>(`/agents/${agent}/state?as=${viewer}`).catch(() => null), sealed: true };
    },
    5_000,
    [agent, viewer],
  );
}

// ─── registry status + kill switch ───
export interface AgentStatus {
  registered: boolean;
  frozen: boolean;
  running: boolean;
  ownedByOperator: boolean;
}

export function useKillSwitch(agent: AgentId, enabled: boolean) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [bump, setBump] = useState(0);
  const status = usePoll(() => (enabled ? operator<AgentStatus>(`/agents/${agent}`) : Promise.resolve(null)), 5_000, [agent, enabled, bump]);
  const toggle = useCallback(
    async (freeze: boolean) => {
      setBusy(true);
      setError(undefined);
      try {
        await operator(`/agents/${agent}/${freeze ? "freeze" : "unfreeze"}`, { method: "POST" });
        setBump((b) => b + 1);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [agent],
  );
  return { status, busy, error, toggle };
}

// ─── decrypting encrypted transfers (owner / auditor) ───
export function useDecrypted(rows: ChainRow[], viewer: Viewer): Map<string, Decrypted> {
  const [map, setMap] = useState(new Map<string, Decrypted>());
  const asked = useRef(new Set<string>());
  useEffect(() => {
    asked.current = new Set();
    setMap(new Map());
  }, [viewer]);
  useEffect(() => {
    if (viewer === "raw") return;
    const todo = rows
      .filter((r) => r.value === undefined && r.shares === undefined && r.kind !== "batch" && r.kind !== "frozen" && r.kind !== "unfrozen")
      .map((r) => r.txHash.toLowerCase())
      .filter((h) => !asked.current.has(`${viewer}:${h}`))
      .slice(0, 20);
    if (todo.length === 0) return;
    for (const h of todo) asked.current.add(`${viewer}:${h}`);
    void operator<{ txHash: string; amount?: string; via?: string; error?: string }[]>("/decrypt/transfers", { method: "POST", body: { txHashes: todo, as: viewer } })
      .then((results) =>
        setMap((prev) => {
          const next = new Map(prev);
          for (const r of results) next.set(r.txHash.toLowerCase(), { amount: r.amount, via: r.via, error: r.error });
          return next;
        }),
      )
      .catch(() => undefined);
  }, [rows, viewer]);
  return map;
}
