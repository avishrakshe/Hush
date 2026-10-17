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
    <section className={`glass rounded-[22px] ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h3 className="text-[13.5px] font-medium text-ink">{title}</h3>
        {aside && <div className="font-mono text-[10.5px] text-ink-faint">{aside}</div>}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Dot({ state }: { state: "up" | "down" | "checking" | "live" | "offline" | "connecting" }) {
  const cls =
    state === "up" || state === "live" ? "bg-gold shadow-[0_0_8px_var(--gold)]" : state === "down" || state === "offline" ? "bg-leak" : "bg-ink-faint";
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
    <a href={addressUrl(address)} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-2 hover:decoration-gold">
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
  tone?: "default" | "gold" | "seal" | "leak" | "danger";
  disabled?: boolean;
  pressed?: boolean;
}) {
  const tones = {
    default: "border-line-strong text-ink hover:bg-white/[0.06]",
    gold: "border-gold/40 text-gold hover:bg-gold/10",
    seal: "border-seal/50 text-seal hover:bg-seal/10",
    leak: "border-leak/40 text-leak hover:bg-leak/10",
    danger: "border-avax/50 text-avax hover:bg-avax/10",
  };
  // Pressed = the selected segment: filled gold, like a BUY/SELL toggle.
  const on = "border-transparent bg-gradient-to-b from-gold-hi to-gold text-black shadow-[0_0_20px_-6px_var(--gold)]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className={`whitespace-nowrap rounded-full border px-4 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${pressed ? on : tones[tone]}`}
    >
      {children}
    </button>
  );
}
