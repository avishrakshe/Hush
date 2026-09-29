"use client";

import { landing, useLanding } from "./state";

/** PUBLIC / HUSH switch. Flips the whole page: 3D scene, observer terminal and copy accents. */
export function ModeToggle({ className = "" }: { className?: string }) {
  const hush = useLanding((s) => s.mode === "hush");
  return (
    <button
      type="button"
      role="switch"
      aria-checked={hush}
      aria-label="Hush mode: encrypt payments"
      onClick={() => landing.toggle()}
      className={`group relative grid grid-cols-2 items-center rounded-full border border-line-strong bg-bg/70 p-1 font-mono text-[11px] uppercase tracking-[0.2em] ${className}`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full ring-1 transition-[translate,background-color,box-shadow] duration-500 ease-[cubic-bezier(.2,.8,.2,1)] ${
          hush
            ? "translate-x-full bg-violet/25 shadow-[0_0_24px_-4px_var(--violet)] ring-cyan/50"
            : "bg-pink/20 shadow-[0_0_24px_-6px_var(--pink)] ring-pink/50"
        }`}
      />
      <span className={`relative px-3.5 py-1.5 transition-colors ${hush ? "text-ink-faint" : "text-ink"}`}>Public</span>
      <span className={`relative px-3.5 py-1.5 transition-colors ${hush ? "text-ink" : "text-ink-faint"}`}>Hush</span>
    </button>
  );
}

/** Big in-copy call to action for THE VEIL chapter. */
export function VeilButton() {
  const hush = useLanding((s) => s.mode === "hush");
  return (
    <button
      type="button"
      onClick={() => landing.toggle()}
      aria-pressed={hush}
      className={`group inline-flex items-center gap-3 rounded-full border px-5 py-3 font-mono text-xs uppercase tracking-[0.2em] transition-colors duration-300 ${
        hush
          ? "border-pink/40 text-pink hover:bg-pink/10"
          : "border-cyan/40 text-cyan hover:bg-cyan/10"
      }`}
    >
      <span aria-hidden className={`size-2 rounded-full ${hush ? "bg-pink" : "bg-cyan"} shadow-[0_0_12px_currentColor]`} />
      {hush ? "Lift the veil — show what x402 leaks" : "Drop the veil — encrypt it"}
    </button>
  );
}
