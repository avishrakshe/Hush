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
      className={`group relative grid grid-cols-2 items-center rounded-full border border-line-strong bg-black/60 p-1 text-[13px] font-medium ${className}`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full transition-[translate,background-color,box-shadow] duration-500 ease-[cubic-bezier(.2,.8,.2,1)] ${
          hush
            ? "translate-x-full bg-gradient-to-b from-gold-hi to-gold shadow-[0_0_24px_-4px_var(--gold)]"
            : "bg-leak/20 shadow-[0_0_24px_-6px_var(--leak)] ring-1 ring-leak/50"
        }`}
      />
      <span className={`relative px-4 py-1.5 transition-colors ${hush ? "text-ink-faint" : "text-ink"}`}>Public</span>
      <span className={`relative px-4 py-1.5 transition-colors ${hush ? "text-black" : "text-ink-faint"}`}>Hush</span>
    </button>
  );
}

/** Big in-copy call to action for THE VEIL chapter. */
export function VeilButton() {
  const hush = useLanding((s) => s.mode === "hush");
  return (
    <button type="button" onClick={() => landing.toggle()} aria-pressed={hush} className={hush ? "btn-ghost" : "btn-gold"}>
      <span aria-hidden>{hush ? "↺" : "✦"}</span>
      {hush ? "Lift the veil — show what x402 leaks" : "Drop the veil — encrypt it"}
    </button>
  );
}
