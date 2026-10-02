"use client";

import { shortHex } from "@/lib/chain";
import { clock, median, usdc } from "@/lib/format";
import type { AgentId } from "@/lib/services";
import type { ChainRow } from "./useChainFeed";
import { Empty, Tx } from "./ui";

export interface Decrypted {
  amount?: string;
  via?: string;
  error?: string;
}

export interface LeakItem {
  label: string;
  leaked: boolean;
  evidence: string;
}

/**
 * What an observer of the chain has learned about the agent so far — computed only from the rows actually seen on
 * Fuji, never assumed. Atlas leaks each item once the evidence shows up; Veil's top-ups expose only the payee.
 */
export function leakItems(agent: AgentId, rows: ChainRow[]): LeakItem[] {
  if (agent === "atlas") {
    const pays = rows.filter((r) => r.kind === "payment");
    const gaps = pays
      .map((r) => r.at)
      .sort((a, b) => a - b)
      .slice(1)
      .map((t, i, arr) => t - (i === 0 ? pays.map((r) => r.at).sort((a, b) => a - b)[0]! : arr[i - 1]!));
    const gap = median(gaps);
    const total = pays.reduce((s, r) => s + (r.value ?? 0n), 0n);
    return [
      { label: "Who it pays", leaked: pays.length > 0, evidence: pays[0]?.to ? `→ ${shortHex(pays[0].to)}` : "waiting for a payment" },
      { label: "What each call costs", leaked: pays.length > 0, evidence: pays[0]?.value !== undefined ? `${usdc(pays[0].value)} USDC, in the clear` : "—" },
      { label: "How often it calls", leaked: pays.length >= 2, evidence: gap ? `one payment every ~${Math.round(gap / 1000)} s` : "needs two payments" },
      { label: "What it spends", leaked: pays.length > 0, evidence: `${usdc(total)} USDC across ${pays.length} payments` },
    ];
  }
  const topups = rows.filter((r) => r.kind === "topup");
  return [
    { label: "Who it pays", leaked: topups.length > 0, evidence: topups.length ? "top-up receiver is public (known limitation)" : "no top-up in view" },
    { label: "What each call costs", leaked: false, evidence: "calls are off-chain vouchers" },
    { label: "How often it calls", leaked: false, evidence: "only roots, on a fixed 2-min clock" },
    { label: "What it spends", leaked: false, evidence: `${topups.length} top-up${topups.length === 1 ? "" : "s"}, amounts encrypted` },
  ];
}

export function PrivacyMeter({ items, accent }: { items: LeakItem[]; accent: "pink" | "cyan" }) {
  const leaked = items.filter((i) => i.leaked).length;
  const pct = Math.round((leaked / items.length) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-dim">Strategy exposed to observers</p>
        <p className={`font-display text-2xl font-semibold tabular-nums ${accent === "pink" ? "text-pink" : "text-cyan"}`}>{pct}%</p>
      </div>
      <div className="mt-2 flex gap-1" aria-hidden>
        {items.map((i) => (
          <span key={i.label} className={`h-1.5 flex-1 rounded-full transition-colors duration-700 ${i.leaked ? "bg-pink shadow-[0_0_10px_var(--pink)]" : "bg-white/[0.08]"}`} />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5 text-[12.5px]">
        {items.map((i) => (
          <li key={i.label} className="grid grid-cols-[1.1rem_9.5rem_1fr] items-baseline gap-x-2">
            <span aria-label={i.leaked ? "leaked" : "hidden"} className={i.leaked ? "text-pink" : "text-cyan"}>
              {i.leaked ? "●" : "○"}
            </span>
            <span className="text-ink">{i.label}</span>
            <span className="truncate font-mono text-[11px] text-ink-faint">{i.evidence}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const LABEL: Record<string, string> = {
  payment: "x402 payment",
  topup: "eERC top-up",
  allocation: "treasury → agent",
  refund: "credit refund",
  transfer: "eERC transfer",
  frozen: "kill switch: frozen",
  unfrozen: "kill switch: unfrozen",
};

/** On-chain rows as an observer sees them; amounts appear only when the viewer can decrypt them. */
export function ChainList({ rows, decrypted, names }: { rows: ChainRow[]; decrypted?: Map<string, Decrypted>; names: Record<string, string> }) {
  const shown = rows.filter((r) => r.kind !== "batch").slice(0, 9);
  if (shown.length === 0) return <Empty>nothing on-chain in the last ~90 min</Empty>;
  const name = (a?: string) => (a ? (names[a.toLowerCase()] ?? shortHex(a)) : "?");
  return (
    <ol className="space-y-1.5 font-mono text-[11px]">
      {shown.map((r) => {
        const d = decrypted?.get(r.txHash.toLowerCase());
        const kill = r.kind === "frozen" || r.kind === "unfrozen";
        return (
          <li key={r.key} className="line-in grid grid-cols-[4.2rem_1fr_auto] items-baseline gap-x-2">
            <span className="text-ink-faint">{clock(r.at)}</span>
            <span className="min-w-0 truncate">
              <span className={kill ? "text-ink" : "text-ink-dim"}>{LABEL[r.kind]}</span>
              {!kill && (
                <span className="text-ink-faint">
                  {" "}
                  {name(r.from)} → {name(r.to)}
                </span>
              )}
            </span>
            <span className="flex items-baseline gap-2">
              {r.value !== undefined ? (
                <span className="text-pink">{usdc(r.value)} USDC</span>
              ) : kill ? null : d?.amount ? (
                <span className="text-cyan" title={d.via}>
                  {usdc(d.amount)} hUSDC 🔓
                </span>
              ) : (
                <span className="text-violet">encrypted</span>
              )}
              <Tx hash={r.txHash} label="tx" />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Last 30 minutes of on-chain footprint, one mark per event. */
export function Footprint({ rows, batches, now, agent }: { rows: ChainRow[]; batches: ChainRow[]; now: number; agent: AgentId }) {
  const span = 30 * 60_000;
  const x = (at: number) => Math.max(0, Math.min(100, ((at - (now - span)) / span) * 100));
  const inView = (r: ChainRow) => r.at >= now - span;
  const own = rows.filter(inView);
  const roots = agent === "veil" ? batches.filter(inView) : [];
  return (
    <figure>
      <svg viewBox="0 0 100 22" preserveAspectRatio="none" className="h-10 w-full" role="img" aria-label={`${own.length} on-chain events in the last 30 minutes`}>
        <line x1="0" x2="100" y1="16" y2="16" stroke="var(--line-strong)" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
        {roots.map((r) => (
          <rect key={r.key} x={x(r.at) - 0.15} y="7" width="0.3" height="9" fill="var(--cyan)" opacity="0.8" />
        ))}
        {own.map((r) =>
          r.kind === "payment" ? (
            <rect key={r.key} x={x(r.at) - 0.2} y="3" width="0.4" height="13" fill="var(--pink)" />
          ) : r.kind === "frozen" || r.kind === "unfrozen" ? (
            <rect key={r.key} x={x(r.at) - 0.2} y="1" width="0.4" height="15" fill="var(--ink)" />
          ) : (
            <rect key={r.key} x={x(r.at) - 0.6} y="10" width="1.2" height="6" fill="var(--violet)" />
          ),
        )}
      </svg>
      <figcaption className="mt-1 flex justify-between font-mono text-[10px] text-ink-faint">
        <span>30 min ago</span>
        <span>
          {agent === "atlas" ? (
            <>
              <span className="text-pink">■</span> payment
            </>
          ) : (
            <>
              <span className="text-violet">■</span> encrypted transfer · <span className="text-cyan">|</span> batch root
            </>
          )}
        </span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}
