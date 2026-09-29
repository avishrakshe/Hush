"use client";

import { EXPLORER, addressUrl, shortHex } from "@/lib/chain";
import type { ProofSnapshot } from "@/lib/proof";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

const REFRESH_MS = 30_000;

type Load = { status: "idle" | "loading" } | { status: "ok"; data: ProofSnapshot } | { status: "error"; error: string };

/** PROOF chapter: the live Fuji deployment, read through /api/proof (view calls only). */
export function ProofPanel() {
  const [load, setLoad] = useState<Load>({ status: "idle" });
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const fetchSnapshot = useCallback(async () => {
    setLoad((l) => (l.status === "ok" ? l : { status: "loading" }));
    try {
      const res = await fetch("/api/proof");
      const body = (await res.json()) as ProofSnapshot | { error: string };
      if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
      setLoad({ status: "ok", data: body });
    } catch (err) {
      setLoad({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), { rootMargin: "400px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    void fetchSnapshot();
    const timer = setInterval(fetchSnapshot, REFRESH_MS);
    return () => clearInterval(timer);
  }, [visible, fetchSnapshot]);

  return (
    <div ref={ref} className="space-y-4">
      {load.status === "ok" ? (
        <Snapshot data={load.data} />
      ) : load.status === "error" ? (
        <div className="glass rounded-2xl p-6 font-mono text-sm">
          <p className="text-ink-dim">Couldn&apos;t reach Fuji just now.</p>
          <p className="mt-1 text-xs text-ink-faint">{load.error}</p>
          <button type="button" onClick={fetchSnapshot} className="mt-4 rounded-full border border-line-strong px-4 py-2 text-xs uppercase tracking-[0.18em] hover:bg-white/5">
            Retry
          </button>
        </div>
      ) : (
        <Skeleton />
      )}
    </div>
  );
}

function Snapshot({ data }: { data: ProofSnapshot }) {
  const provider = data.providers[0];
  return (
    <>
      <div className="glass flex flex-wrap items-center justify-between gap-3 rounded-2xl px-5 py-3 font-mono text-xs">
        <span className="flex items-center gap-2 text-ink-dim">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-avax opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex size-2 rounded-full bg-avax" />
          </span>
          Avalanche Fuji C-Chain · chain {data.chainId}
        </span>
        <span className="text-ink-faint">
          block <span className="text-ink">#{Number(data.blockNumber).toLocaleString("en-US")}</span>
        </span>
      </div>

      {provider && (
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="glass rounded-2xl p-5 lg:col-span-3">
            <p className="kicker">What the chain stores for {provider.name}&apos;s balance</p>
            <div className="mt-4 space-y-2 break-all font-mono text-[11px] leading-relaxed">
              <p>
                <span className="text-ink-faint">c1 = (</span>
                <span className="text-violet">{shortHex(provider.encryptedBalance.c1[0], 18, 8)}</span>
                <span className="text-ink-faint">, </span>
                <span className="text-violet">{shortHex(provider.encryptedBalance.c1[1], 18, 8)}</span>
                <span className="text-ink-faint">)</span>
              </p>
              <p>
                <span className="text-ink-faint">c2 = (</span>
                <span className="text-cyan">{shortHex(provider.encryptedBalance.c2[0], 18, 8)}</span>
                <span className="text-ink-faint">, </span>
                <span className="text-cyan">{shortHex(provider.encryptedBalance.c2[1], 18, 8)}</span>
                <span className="text-ink-faint">)</span>
              </p>
            </div>
            <p className="mt-4 text-sm text-ink-dim">
              An ElGamal ciphertext on BabyJubJub. Only the provider&apos;s eERC key — and the auditor&apos;s — can turn it
              back into a number.
            </p>
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-[11px] sm:grid-cols-3">
              <Fact label="provider" value={<Ext href={addressUrl(provider.address)}>{shortHex(provider.address)}</Ext>} />
              <Fact label="list price" value={`${provider.pricePerCall} USDC / call`} />
              <Fact label="endpoint" value={provider.endpoint.replace(/^https?:\/\//, "")} />
            </dl>
          </div>

          <div className="glass rounded-2xl p-5 lg:col-span-2">
            <p className="kicker">HushLedger · batch roots</p>
            {provider.roots.length ? (
              <ol className="mt-4 space-y-2 font-mono text-[11px]">
                {provider.roots.map((r, i) => (
                  <li key={r.batchId} className="flex items-center justify-between gap-3">
                    <span className={i === 0 ? "text-ink" : "text-ink-faint"}>#{r.batchId}</span>
                    <span className={i === 0 ? "text-cyan" : "text-ink-dim"}>{shortHex(r.root, 10, 8)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-4 font-mono text-xs text-ink-faint">no batches committed yet</p>
            )}
            <p className="mt-4 text-sm text-ink-dim">
              A root per cadence tick, padded when idle. No counts, no amounts — agents prove their own vouchers are
              inside.
            </p>
          </div>
        </div>
      )}

      <div className="glass overflow-hidden rounded-2xl">
        <table className="w-full text-left font-mono text-[11px]">
          <caption className="sr-only">Hush contracts on Avalanche Fuji</caption>
          <tbody>
            {data.contracts.map((c) => (
              <tr key={c.name} className="border-b border-line last:border-0">
                <th scope="row" className="px-5 py-2.5 font-medium text-ink">
                  {c.name}
                </th>
                <td className="hidden px-2 py-2.5 text-ink-faint md:table-cell">{c.role}</td>
                <td className="px-5 py-2.5 text-right">
                  <Ext href={addressUrl(c.address)}>{shortHex(c.address)}</Ext>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 font-mono text-[11px] sm:grid-cols-2">
        <div className="glass rounded-2xl px-5 py-3">
          <span className="text-ink-faint">auditor </span>
          <Ext href={addressUrl(data.auditor.address)}>{shortHex(data.auditor.address)}</Ext>
          <span className={data.auditor.keySet ? "ml-2 text-cyan" : "ml-2 text-pink"}>{data.auditor.keySet ? "key set ✓" : "no key"}</span>
        </div>
        <div className="glass rounded-2xl px-5 py-3">
          <span className="text-ink-faint">wrapped into hUSDC </span>
          <span className="text-ink">{Number(data.lockedUsdc).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC</span>
          <span className="text-ink-faint"> · deposits public, transfers not</span>
        </div>
      </div>
      <p className="font-mono text-[10px] text-ink-faint">
        read {new Date(data.fetchedAt).toLocaleTimeString()} via view calls ·{" "}
        <Ext href={EXPLORER}>testnet.snowtrace.io</Ext>
      </p>
    </>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
    </div>
  );
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-cyan">
      {children}
    </a>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading live Fuji data">
      <div className="glass h-11 animate-pulse rounded-2xl motion-reduce:animate-none" />
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="glass h-56 animate-pulse rounded-2xl motion-reduce:animate-none lg:col-span-3" />
        <div className="glass h-56 animate-pulse rounded-2xl motion-reduce:animate-none lg:col-span-2" />
      </div>
      <div className="glass h-48 animate-pulse rounded-2xl motion-reduce:animate-none" />
    </div>
  );
}
