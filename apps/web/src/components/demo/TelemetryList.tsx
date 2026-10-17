"use client";

import { clock } from "@/lib/format";
import type { TelemetryRow } from "./useTelemetry";
import { Empty } from "./ui";

const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** One line per agent event — what the agent itself recorded (sealed for Veil). */
export function describeEvent(type: string, d: Record<string, unknown> = {}): { text: string; tone: string } {
  switch (type) {
    case "signal":
      return { text: `bought signal: ${s(d.ticker)} ${s(d.direction)} (${s(d.confidence)}) @ $${s(d.price)}`, tone: "text-ink" };
    case "trade":
      return { text: `${s(d.side)} ${s(d.shares)} ${s(d.ticker)} @ $${s(d.price)} · ${s(d.footprint)}`, tone: "text-ink" };
    case "position":
      return { text: `position ${s(d.shares)} ${s(d.ticker)}${d.avgCost ? ` avg $${s(d.avgCost)}` : ""} · statement #${s(d.seq)} desk-signed`, tone: "text-cyan" };
    case "decision":
      return { text: `tick ${s(d.tick)}: ${s(d.action)}${d.shares ? ` ${s(d.shares)}` : ""} — ${s(d.rationale)}`, tone: "text-ink-dim" };
    case "provider-check": {
      const ps = (d.providers as { name?: string; verified?: number | null; claimed?: number | null; passes?: boolean }[] | undefined) ?? [];
      const pct = (x?: number | null) => (typeof x === "number" ? `${Math.round(x * 100)}%` : "–");
      return {
        text: `provider check (${s(d.by)}): ${ps.map((p) => `${p.name}: claims ${pct(p.claimed)}${d.by === "verify" ? `, verified ${pct(p.verified)}${p.passes ? " ✓" : ""}` : ""}`).join(" · ")}`,
        tone: "text-violet",
      };
    }
    case "trade:failed":
    case "signal:failed":
      return { text: `${type}: ${s(d.error)}`, tone: "text-pink" };
    default:
      if (type.startsWith("sdk:topup")) return { text: `${type.slice(4)} ${d.amount ? `$${(Number(d.amount) / 1e6).toFixed(2)}` : ""}`, tone: "text-violet" };
      if (type.startsWith("sdk:voucher")) return { text: `${type.slice(4)}${d.amount ? ` $${(Number(d.amount) / 1e6).toFixed(4)}` : ""}`, tone: "text-ink-faint" };
      if (type.startsWith("sdk:payment")) return { text: `${type.slice(4)}${d.amount ? ` $${(Number(d.amount) / 1e6).toFixed(4)}` : ""}`, tone: "text-ink-faint" };
      return { text: `${type}`, tone: "text-ink-faint" };
  }
}

export function TelemetryList({ rows, limit = 12, hideNoise = true }: { rows: TelemetryRow[]; limit?: number; hideNoise?: boolean }) {
  const shown = rows.filter((r) => !hideNoise || !r.type || !/^sdk:voucher/.test(r.type)).slice(0, limit);
  if (shown.length === 0) return <Empty>no events yet</Empty>;
  return (
    <ol className="space-y-1.5 font-mono text-[11px]">
      {shown.map((r) => {
        if (r.locked || (r.sealed && !r.type)) {
          return (
            <li key={r.id} className="line-in grid grid-cols-[4.2rem_1fr] gap-x-2">
              <span className="text-ink-faint">{clock(r.at)}</span>
              <span className="truncate text-violet">
                🔒 sealed event{r.sealedBytes ? ` · ${r.sealedBytes}-byte ciphertext` : ""} {r.locked ? "— not addressed to you" : "— owner + auditor keys only"}
              </span>
            </li>
          );
        }
        const { text, tone } = describeEvent(r.type ?? "?", r.data);
        return (
          <li key={r.id} className="line-in grid grid-cols-[4.2rem_1fr] gap-x-2">
            <span className="text-ink-faint">{clock(r.at)}</span>
            <span className={`min-w-0 truncate ${tone}`} title={text}>
              {r.sealed && <span className="text-cyan">🔓 </span>}
              {text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
