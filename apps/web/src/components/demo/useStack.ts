"use client";

import { FUJI_CONTRACTS } from "@/lib/net";
import { SERVICES, type ServiceName, getJson } from "@/lib/services";
import type { HushContracts } from "@hush/x402/contracts";
import { useEffect, useState } from "react";
import type { Address } from "viem";

export type Health = "checking" | "up" | "down";

interface OperatorHealth {
  network: string;
  contracts: HushContracts;
  owner: Address;
  auditor: Address;
  provider: Address | null;
  providerAdmin: boolean;
  agents: { id: string; address: Address }[];
}

/** Addresses the demo watches on-chain. */
export interface FeedTargets {
  atlas: Address;
  veil: Address;
  provider: Address;
  desk?: Address;
  alphaking?: Address;
  mirror?: Address;
  owner?: Address;
}

export interface Stack {
  health: Record<ServiceName, Health>;
  /** The chain the stack runs on (Fuji unless the operator says otherwise). */
  contracts: HushContracts;
  network: string;
  targets: FeedTargets | null;
  operator?: OperatorHealth;
}

const HEALTH_PATH: Record<ServiceName, string> = {
  facilitator: "/health",
  provider: "/health",
  alphaking: "/",
  desk: "/health",
  mirror: "/health",
  operator: "/health",
  atlas: "/health",
  veil: "/health",
};

const sameTargets = (a: FeedTargets | null, b: FeedTargets) =>
  !!a && (Object.keys(b) as (keyof FeedTargets)[]).every((k) => a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length;

/**
 * Polls the local demo stack. Addresses come from whichever services are up (operator first, else each service's own
 * /health), so the public observer view works without the operator.
 */
export function useStack(pollMs = 5_000): Stack {
  const [stack, setStack] = useState<Stack>({
    health: Object.fromEntries(Object.keys(SERVICES).map((n) => [n, "checking"])) as Record<ServiceName, Health>,
    contracts: FUJI_CONTRACTS,
    network: "fuji",
    targets: null,
  });

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      const names = Object.keys(SERVICES) as ServiceName[];
      const bodies = await Promise.all(names.map((n) => getJson<Record<string, unknown>>(`${SERVICES[n]}${HEALTH_PATH[n]}`)));
      const by = Object.fromEntries(names.map((n, i) => [n, bodies[i]])) as Record<ServiceName, Record<string, unknown> | null>;
      const op = by.operator as unknown as OperatorHealth | null;
      const a = (v: unknown) => (typeof v === "string" && v.startsWith("0x") ? (v as Address) : undefined);
      const agentAddr = (id: "atlas" | "veil") => op?.agents.find((x) => x.id === id)?.address ?? a(by[id]?.address);
      const atlas = agentAddr("atlas");
      const veil = agentAddr("veil");
      const provider = op?.provider ?? a(by.facilitator?.provider) ?? a(by.mirror?.provider);
      const extra = {
        desk: a(by.desk?.provider) ?? a(by.mirror?.desk),
        alphaking: a(by.alphaking?.payTo),
        mirror: a(by.mirror?.mirror),
        owner: op?.owner,
      };
      const network = op?.network ?? (by.facilitator?.network as string | undefined) ?? "fuji";
      if (stopped) return;
      setStack((prev) => {
        const next: FeedTargets | null =
          atlas && veil && provider
            ? (Object.fromEntries(Object.entries({ atlas, veil, provider, ...extra }).filter(([, v]) => v)) as unknown as FeedTargets)
            : null;
        return {
          health: Object.fromEntries(names.map((n) => [n, by[n] ? "up" : "down"])) as Record<ServiceName, Health>,
          contracts: op?.contracts && op.contracts.chainId === prev.contracts.chainId && prev.operator ? prev.contracts : (op?.contracts ?? prev.contracts),
          network,
          targets: next ? (sameTargets(prev.targets, next) ? prev.targets : next) : prev.targets,
          operator: op ?? undefined,
        };
      });
      timer = setTimeout(check, pollMs);
    };
    void check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pollMs]);

  return stack;
}
