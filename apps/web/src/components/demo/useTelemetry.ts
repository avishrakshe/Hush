"use client";

import { type AgentId, SERVICES } from "@/lib/services";
import { useEffect, useState } from "react";

export type Viewer = "raw" | "owner" | "auditor";

/** One entry of an agent's own event log. `type`/`data` are absent while the entry is still sealed. */
export interface TelemetryRow {
  id: number;
  at: number;
  type?: string;
  data?: Record<string, unknown>;
  /** The agent sealed this entry to its owner + auditor keys. */
  sealed: boolean;
  /** Size of the ciphertext an outsider sees, in bytes. */
  sealedBytes?: number;
  /** Sealed and not addressed to this viewer. */
  locked?: boolean;
}

interface RawEvent {
  id: number;
  at: number;
  type?: string;
  data?: Record<string, unknown>;
  sealed?: boolean | { ciphertext: string; recipients: unknown[] };
  locked?: boolean;
}

/**
 * The agent's telemetry. `raw` reads the agent's stream directly (sealed blobs for Veil); `owner`/`auditor` read the
 * same stream through the local operator, which decrypts it with that party's eERC key.
 */
export function useTelemetry(agent: AgentId, viewer: Viewer) {
  const [rows, setRows] = useState<TelemetryRow[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");

  useEffect(() => {
    setRows([]);
    setStatus("connecting");
    const url = viewer === "raw" ? `${SERVICES[agent]}/events` : `${SERVICES.operator}/reveal/${agent}?as=${viewer}`;
    const es = new EventSource(url);
    es.onopen = () => setStatus("live");
    es.onerror = () => setStatus("offline");
    es.addEventListener("offline", () => setStatus("offline"));
    es.onmessage = (m: MessageEvent<string>) => {
      const e = JSON.parse(m.data) as RawEvent;
      const blob = typeof e.sealed === "object" ? e.sealed : undefined;
      const row: TelemetryRow = {
        id: e.id,
        at: e.at,
        type: e.type,
        data: e.data,
        sealed: !!e.sealed,
        sealedBytes: blob ? (blob.ciphertext.length - 2) / 2 : undefined,
        locked: e.locked,
      };
      setStatus("live");
      setRows((prev) => (prev.some((r) => r.id === row.id) ? prev : [row, ...prev].slice(0, 300)));
    };
    return () => es.close();
  }, [agent, viewer]);

  return { rows, status };
}
