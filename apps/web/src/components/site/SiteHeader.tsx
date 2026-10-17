"use client";

import { REPO_URL } from "@/lib/chain";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const NAV: { href: string; label: string; accent?: boolean }[] = [
  { href: "/demo", label: "Live demo" },
  { href: "/console/agent", label: "Agent console" },
  { href: "/console/provider", label: "Provider console" },
  { href: "/docs", label: "Docs" },
];

export function Logo({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <circle cx="32" cy="32" r="17" fill="none" stroke="var(--gold)" strokeWidth="3.5" />
      <path d="M9 33.5h46" stroke="var(--gold-deep)" strokeWidth="5" strokeLinecap="round" />
      <path d="M15 33.5h34" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Floating pill navigation. Inner pages: sticky, with the page links. The landing passes its own chapter links and
 * the PUBLIC/HUSH toggle as `right`, and pins it (`fixed`) over the 3D scene.
 */
export function SiteHeader({ links, right, fixed = false }: { links?: { href: string; label: string; accent?: boolean }[]; right?: ReactNode; fixed?: boolean }) {
  const path = usePathname();
  const items = links ?? NAV;
  return (
    <header className={`${fixed ? "fixed inset-x-0" : "sticky"} top-0 z-50 px-3 pt-4 sm:px-6`}>
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 rounded-full border border-gold/20 bg-black/65 py-2 pl-4 pr-2 shadow-[0_10px_60px_-20px_rgba(246,196,69,0.35),inset_0_1px_0_rgba(255,231,180,0.06)] backdrop-blur-xl">
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="Hush home">
          <Logo />
          <span className="text-[17px] font-semibold tracking-tight">hush.</span>
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-1 text-[14px] lg:flex">
          {items.map((n) => {
            const active = !n.href.startsWith("#") && (path === n.href || path.startsWith(`${n.href}/`));
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-full px-3 py-1.5 transition-colors ${active ? "bg-white/[0.08] text-ink" : n.accent ? "text-gold hover:text-gold-hi" : "text-ink-dim hover:text-ink"}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          {right}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-full bg-ink px-4 py-2 text-[14px] font-medium text-black transition-colors hover:bg-gold-hi"
          >
            GitHub ↗
          </a>
        </div>
      </div>
      {/* compact page links below the pill on small screens */}
      <nav aria-label="Main (compact)" className="mx-auto mt-2 flex max-w-6xl gap-1 overflow-x-auto px-1 text-[13px] [scrollbar-width:none] lg:hidden [&::-webkit-scrollbar]:hidden">
        {items.map((n) => (
          <Link key={n.href} href={n.href} className="whitespace-nowrap rounded-full border border-line bg-black/60 px-3 py-1 text-ink-dim backdrop-blur-md hover:text-ink">
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
