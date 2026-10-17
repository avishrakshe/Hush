"use client";

import { shortHex } from "@/lib/chain";
import { clock, median, shares, usdc } from "@/lib/format";
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

const PUBLIC_PAYMENT = new Set(["payment", "signal-payment", "trade-payment"]);
const PUBLIC_TRADE = new Set(["delivery", "stock-sale"]);

/**
 * What an observer of the chain has learned about the agent so far — computed only from the rows actually seen on
 * chain, never assumed. Atlas leaks each item once the evidence shows up; Veil's top-ups expose only the payee.
 */
export function leakItems(agent: AgentId, rows: ChainRow[]): LeakItem[] {
  if (agent === "atlas") {
    const signals = rows.filter((r) => r.kind === "signal-payment");
    const trades = rows.filter((r) => PUBLIC_TRADE.has(r.kind));
    const times = trades.map((r) => r.at).sort((a, b) => a - b);
    const gap = median(times.slice(1).map((t, i) => t - times[i]!));
    const held = new Map<string, bigint>();
    for (const r of trades) held.set(r.ticker ?? "?", (held.get(r.ticker ?? "?") ?? 0n) + (r.kind === "delivery" ? 1n : -1n) * (r.shares ?? 0n));
    const position = [...held].filter(([, v]) => v !== 0n).map(([k, v]) => `${shares(v)} m${k}`).join(", ");
    const last = trades[0];
    return [
      { label: "Where it buys signals", leaked: signals.length > 0, evidence: signals[0] ? `${usdc(signals[0].value ?? 0n)} USDC → ${shortHex(signals[0].to ?? "")}` : "no signal purchase yet" },
      { label: "What it trades", leaked: trades.length > 0, evidence: last ? `${last.kind === "delivery" ? "bought" : "sold"} ${shares(last.shares ?? 0n)} m${last.ticker}` : "no trade yet" },
      { label: "When it trades", leaked: trades.length >= 2, evidence: gap ? `a trade every ~${Math.round(gap / 1000)} s, right after each signal` : "needs two trades" },
      { label: "What it holds", leaked: trades.length > 0, evidence: position || (trades.length ? "flat" : "—") },
    ];
  }
  const topups = rows.filter((r) => r.kind === "topup");
  return [
    { label: "Where it buys signals", leaked: topups.length > 0, evidence: topups.length ? "top-up receivers are public (known limitation)" : "no top-up in view" },
    { label: "What it trades", leaked: false, evidence: "trades are off-chain vouchers at the desk" },
    { label: "When it trades", leaked: false, evidence: "only batch roots, on a fixed clock" },
    { label: "What it holds", leaked: false, evidence: "custodied — only desk-signed statements" },
  ];
}

export function PrivacyMeter({ items, accent }: { items: LeakItem[]; accent: "leak" | "gold" }) {
  const leaked = items.filter((i) => i.leaked).length;
  const pct = Math.round((leaked / items.length) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-dim">Strategy exposed to observers</p>
        <p className={`font-display text-2xl font-semibold tabular-nums ${accent === "leak" ? "text-leak" : "text-gold"}`}>{pct}%</p>
      </div>
      <div className="mt-2 flex gap-1" aria-hidden>
        {items.map((i) => (
          <span key={i.label} className={`h-1.5 flex-1 rounded-full transition-colors duration-700 ${i.leaked ? "bg-leak shadow-[0_0_10px_var(--leak)]" : "bg-white/[0.08]"}`} />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5 text-[12.5px]">
        {items.map((i) => (
          <li key={i.label} className="grid grid-cols-[1.1rem_9.5rem_1fr] items-baseline gap-x-2">
            <span aria-label={i.leaked ? "leaked" : "hidden"} className={i.leaked ? "text-leak" : "text-gold"}>
              {i.leaked ? "●" : "○"}
            </span>
            <span className="text-ink">{i.label}</span>
            <span className="truncate font-mono text-[11px] text-ink-faint" title={i.evidence}>
              {i.evidence}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const LABEL: Record<string, string> = {
  payment: "USDC payment",
  "signal-payment": "x402 signal payment",
  "trade-payment": "x402 trade payment",
  proceeds: "sale proceeds",
  delivery: "stock delivered",
  "stock-sale": "stock sold",
  topup: "eERC top-up",
  allocation: "treasury → agent",
  refund: "credit refund",
  "settle-out": "settle-out",
  transfer: "eERC transfer",
  frozen: "kill switch: frozen",
  unfrozen: "kill switch: unfrozen",
};

/** On-chain rows as an observer sees them; amounts appear only when public or when the viewer can decrypt them. */
export function ChainList({ rows, decrypted, names, limit = 9 }: { rows: ChainRow[]; decrypted?: Map<string, Decrypted>; names: Record<string, string>; limit?: number }) {
  const shown = rows.filter((r) => r.kind !== "batch").slice(0, limit);
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
                <span className="text-leak">{usdc(r.value)} USDC</span>
              ) : r.shares !== undefined ? (
                <span className="text-leak">
                  {shares(r.shares)} m{r.ticker}
                </span>
              ) : kill ? null : d?.amount ? (
                <span className="text-gold" title={d.via}>
                  {usdc(d.amount)} 🔓
                </span>
              ) : (
                <span className="text-seal">encrypted</span>
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
          <rect key={r.key} x={x(r.at) - 0.15} y="7" width="0.3" height="9" fill="var(--gold)" opacity="0.8" />
        ))}
        {own.map((r) =>
          PUBLIC_PAYMENT.has(r.kind) || r.kind === "proceeds" ? (
            <rect key={r.key} x={x(r.at) - 0.2} y="3" width="0.4" height="13" fill="var(--leak)" />
          ) : PUBLIC_TRADE.has(r.kind) ? (
            <rect key={r.key} x={x(r.at) - 0.2} y="0" width="0.4" height="16" fill="var(--avax)" />
          ) : r.kind === "frozen" || r.kind === "unfrozen" ? (
            <rect key={r.key} x={x(r.at) - 0.2} y="1" width="0.4" height="15" fill="var(--ink)" />
          ) : (
            <rect key={r.key} x={x(r.at) - 0.6} y="10" width="1.2" height="6" fill="var(--seal)" />
          ),
        )}
      </svg>
      <figcaption className="mt-1 flex justify-between font-mono text-[10px] text-ink-faint">
        <span>30 min ago</span>
        <span>
          {agent === "atlas" ? (
            <>
              <span className="text-leak">■</span> USDC payment · <span className="text-avax">■</span> stock transfer
            </>
          ) : (
            <>
              <span className="text-seal">■</span> encrypted transfer · <span className="text-gold">|</span> batch root
            </>
          )}
        </span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}
