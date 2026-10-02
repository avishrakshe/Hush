"use client";

import { SERVICES, type ServiceName } from "@/lib/services";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { FeedTargets } from "./useChainFeed";

export type Health = "checking" | "up" | "down";

interface OperatorHealth {
  owner: Address;
  auditor: Address;
  provider: Address | null;
  providerAdmin: boolean;
  agents: { id: string; address: Address }[];
}

export interface Stack {
  health: Record<ServiceName, Health>;
  targets: FeedTargets | null;
  operator?: OperatorHealth;
}

const HEALTH_PATH: Record<ServiceName, string> = {
  facilitator: "/health",
  provider: "/health",
  operator: "/health",
  atlas: "/health",
  veil: "/health",
};

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_500) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Polls the local demo stack. Addresses come from whichever services are up (operator first, else the agents'
 * and facilitator's own /health), so the public observer view works even without the operator.
 */
export function useStack(pollMs = 5_000): Stack {
  const [stack, setStack] = useState<Stack>({
    health: { facilitator: "checking", provider: "checking", operator: "checking", atlas: "checking", veil: "checking" },
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
      const agentAddr = (id: "atlas" | "veil") =>
        (op?.agents.find((a) => a.id === id)?.address ?? (by[id]?.address as Address | undefined)) || undefined;
      const provider = (op?.provider ?? (by.facilitator?.provider as Address | undefined)) || undefined;
      const atlas = agentAddr("atlas");
      const veil = agentAddr("veil");
      if (stopped) return;
      setStack((prev) => {
        const targets =
          atlas && veil && provider
            ? prev.targets && prev.targets.atlas === atlas && prev.targets.veil === veil && prev.targets.owner === op?.owner
              ? prev.targets
              : { atlas, veil, provider, owner: op?.owner }
            : prev.targets;
        return {
          health: Object.fromEntries(names.map((n) => [n, by[n] ? "up" : "down"])) as Record<ServiceName, Health>,
          targets,
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
