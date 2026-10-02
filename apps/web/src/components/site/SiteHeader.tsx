"use client";

import { REPO_URL } from "@/lib/chain";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/demo", label: "Live demo" },
  { href: "/console/agent", label: "Agent console" },
  { href: "/console/provider", label: "Provider console" },
  { href: "/docs", label: "Docs" },
];

export function Logo({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <circle cx="32" cy="32" r="17" fill="none" stroke="var(--cyan)" strokeWidth="3.5" />
      <path d="M9 33.5h46" stroke="var(--violet)" strokeWidth="5" strokeLinecap="round" />
      <path d="M15 33.5h34" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Header for every page except the landing (which has its own, with the PUBLIC/HUSH toggle). */
export function SiteHeader() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-5 py-3.5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Hush home">
          <Logo />
          <span className="font-display text-lg font-semibold tracking-tight">hush</span>
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1 overflow-x-auto font-mono text-[11px] uppercase tracking-[0.16em]">
          {NAV.map((n) => {
            const active = path === n.href || path.startsWith(`${n.href}/`);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-full px-3 py-1.5 transition-colors ${active ? "bg-white/[0.07] text-ink" : "text-ink-dim hover:text-ink"}`}
              >
                {n.label}
              </Link>
            );
          })}
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="hidden whitespace-nowrap px-3 py-1.5 text-ink-dim hover:text-ink sm:inline">
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}
