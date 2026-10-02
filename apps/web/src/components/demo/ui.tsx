"use client";

import { addressUrl, shortHex, txUrl } from "@/lib/chain";
import { type ReactNode, useEffect, useState } from "react";

/** Re-renders every `ms` so relative times and timelines keep moving. */
export function useNow(ms = 5_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Panel({ title, aside, children, className = "" }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`glass rounded-2xl ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <h3 className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-dim">{title}</h3>
        {aside && <div className="font-mono text-[10.5px] text-ink-faint">{aside}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Dot({ state }: { state: "up" | "down" | "checking" | "live" | "offline" | "connecting" }) {
  const cls = state === "up" || state === "live" ? "bg-cyan" : state === "down" || state === "offline" ? "bg-pink" : "bg-ink-faint";
  return <span aria-hidden className={`inline-block size-1.5 rounded-full ${cls}`} />;
}

export function Tx({ hash, label }: { hash: string; label?: string }) {
  return (
    <a href={txUrl(hash)} target="_blank" rel="noreferrer" className="text-ink-faint underline decoration-line-strong underline-offset-2 hover:text-ink">
      {label ?? shortHex(hash, 6, 4)}
    </a>
  );
}

export function Addr({ address, label }: { address: string; label?: string }) {
  return (
    <a href={addressUrl(address)} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-2 hover:decoration-cyan">
      {label ?? shortHex(address)}
    </a>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center font-mono text-[11px] text-ink-faint">{children}</p>;
}

export function Button({
  children,
  onClick,
  tone = "default",
  disabled,
  pressed,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "default" | "cyan" | "violet" | "pink" | "danger";
  disabled?: boolean;
  pressed?: boolean;
}) {
  const tones = {
    default: "border-line-strong text-ink hover:bg-white/[0.06]",
    cyan: "border-cyan/40 text-cyan hover:bg-cyan/10",
    violet: "border-violet/50 text-violet hover:bg-violet/10",
    pink: "border-pink/40 text-pink hover:bg-pink/10",
    danger: "border-avax/50 text-avax hover:bg-avax/10",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className={`rounded-full border px-3.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]} ${pressed ? "bg-white/[0.08]" : ""}`}
    >
      {children}
    </button>
  );
}
