"use client";

import { useEffect, useRef, useState } from "react";
import { useLanding } from "./state";

/**
 * A (simulated) chain observer watching one agent. In public x402 it reconstructs the agent's strategy from payment
 * receipts; behind the veil it only sees fixed-cadence batch roots and the odd encrypted top-up.
 * Illustrative only — the PROOF chapter and /demo show real Fuji data.
 */

interface Row {
  id: number;
  time: string;
  kind: "pay" | "topup" | "batch";
  cells: [string, string, string];
  accent?: "pink" | "cyan" | "violet" | "ink";
}

const AGENT = "0x4a1e…09c9";
const PROVIDER = "0x77b2…3e41";
const APIS = {
  feed: { name: "feed.api", price: 0.01 },
  search: { name: "search.api", price: 0.02 },
  model: { name: "model.api", price: 0.25 },
} as const;
type Api = keyof typeof APIS;

// A momentum bot: polls a price feed on a metronome and calls a model right after the price moves.
const SCRIPT: { api: Api; dt: number }[] = [
  { api: "feed", dt: 12 },
  { api: "feed", dt: 12 },
  { api: "search", dt: 4 },
  { api: "feed", dt: 8 },
  { api: "model", dt: 1 },
  { api: "feed", dt: 11 },
  { api: "feed", dt: 12 },
  { api: "feed", dt: 12 },
  { api: "model", dt: 1 },
  { api: "search", dt: 5 },
];

const MAX_ROWS = 7;
const TICK_MS = 1100;
const START = 14 * 3600 + 3 * 60; // 14:03:00, simulated

const clock = (s: number) =>
  [Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[(Math.random() * 16) | 0]).join("");
const short = () => `0x${hex(4)}…${hex(4)}`;

function* publicFeed(): Generator<Row, never> {
  let t = START;
  let id = 0;
  for (;;) {
    for (const step of SCRIPT) {
      t += step.dt;
      const api = APIS[step.api];
      yield {
        id: id++,
        time: clock(t),
        kind: "pay",
        cells: [`${AGENT} → ${api.name}`, `${api.price.toFixed(3)} USDC`, step.api === "model" ? "POST /v1/infer" : `GET /${step.api}`],
        accent: step.api === "model" ? "ink" : "pink",
      };
    }
  }
}

function* hushFeed(): Generator<Row | null, never> {
  let t = START;
  let id = 0;
  for (let tick = 0; ; tick++) {
    t += 30; // calls keep happening every tick — as off-chain vouchers the observer never sees
    if (tick % 14 === 0) {
      yield {
        id: id++,
        time: clock(t),
        kind: "topup",
        cells: [`${AGENT} → ${PROVIDER}`, `c1 ${short()}`, `c2 ${short()}`],
        accent: "violet",
      };
    } else if (tick % 4 === 3) {
      yield {
        id: id++,
        time: clock(t),
        kind: "batch",
        cells: [`HushLedger.commitBatch #${212 + Math.floor(tick / 4)}`, `root ${short()}`, "every 120 s"],
        accent: "cyan",
      };
    } else {
      yield null;
    }
  }
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => setReduced(matchMedia("(prefers-reduced-motion: reduce)").matches), []);
  return reduced;
}

export function ObserverTerminal() {
  const mode = useLanding((s) => s.mode);
  const reduced = useReducedMotion();
  const [rows, setRows] = useState<Row[]>([]);
  const [scanned, setScanned] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const feed = useRef<Generator<Row | null> | null>(null);

  useEffect(() => {
    feed.current = mode === "public" ? publicFeed() : hushFeed();
    // Pre-fill so the panel is never empty (and is complete without animation for reduced motion).
    const initial: Row[] = [];
    for (let i = 0; initial.length < (reduced ? MAX_ROWS : 3) && i < 64; i++) {
      const r = feed.current.next().value;
      if (r) initial.push(r);
    }
    setRows(initial);
    setScanned(0);
  }, [mode, reduced]);

  useEffect(() => {
    if (reduced || !visible) return;
    const timer = setInterval(() => {
      setScanned((n) => n + 15); // ~2 s Avalanche blocks per 30 simulated seconds
      const r = feed.current?.next().value;
      if (r) setRows((prev) => [...prev, r].slice(-MAX_ROWS));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [mode, reduced, visible]);

  const hush = mode === "hush";
  const spent = rows.reduce((sum, r) => sum + (r.kind === "pay" ? Number.parseFloat(r.cells[1]) : 0), 0);

  return (
    <div ref={ref} className="glass w-full overflow-hidden rounded-2xl font-mono text-[11.5px] leading-relaxed shadow-2xl shadow-black/40">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-[10px] uppercase tracking-[0.2em] text-ink-faint">
        <span className="flex items-center gap-2">
          <span className={`size-1.5 rounded-full ${hush ? "bg-cyan" : "bg-pink"} shadow-[0_0_10px_currentColor]`} />
          chain observer · watching {AGENT}
        </span>
        <span className="hidden sm:inline">simulated</span>
      </div>

      <ol className="min-h-[13.5rem] space-y-1 px-4 py-3" aria-live="off">
        {rows.map((r) => (
          <li key={`${mode}-${r.id}`} className="line-in grid grid-cols-[4.2rem_1fr] gap-x-3 sm:grid-cols-[4.2rem_1fr_auto]">
            <span className="text-ink-faint">{r.time}</span>
            <span className="truncate text-ink-dim">{r.cells[0]}</span>
            <span className={`col-start-2 truncate sm:col-start-auto ${accent(r.accent)}`}>
              {r.cells[1]}
              <span className="ml-3 text-ink-faint">{r.cells[2]}</span>
            </span>
          </li>
        ))}
        {hush && (
          <li className="grid grid-cols-[4.2rem_1fr] gap-x-3 text-ink-faint">
            <span />
            <span>
              {scanned} blocks scanned · per-call payments: none on-chain<span className="caret">▍</span>
            </span>
          </li>
        )}
      </ol>

      <div className="border-t border-line px-4 py-3 text-[11px]">
        {hush ? (
          <p className="text-cyan/90">
            <span className="text-ink-faint">▸ inference:</span> nothing. Amounts are ElGamal ciphertext, calls never touch
            the chain, and batch roots land every 120 s whether the agent is busy or idle.
          </p>
        ) : (
          <p className="text-pink/90">
            <span className="text-ink-faint">▸ inference:</span> polls feed.api every 12 s, calls model.api right after the
            price moves · {spent.toFixed(2)} USDC in view → momentum bot. The next model call is the next trade.
          </p>
        )}
      </div>
    </div>
  );
}

function accent(a: Row["accent"]) {
  switch (a) {
    case "pink":
      return "text-pink";
    case "ink":
      return "font-semibold text-ink";
    case "cyan":
      return "text-cyan";
    case "violet":
      return "text-violet";
    default:
      return "text-ink";
  }
}
