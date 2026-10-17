"use client";

import { Addr, Button, Dot, Empty, Panel, Tx } from "@/components/demo/ui";
import { usePoll } from "@/components/demo/useDemoData";
import { useStack } from "@/components/demo/useStack";
import { shortHex } from "@/lib/chain";
import { ago, clock, usdc } from "@/lib/format";
import { clientFor } from "@/lib/net";
import { SERVICES, getJson, operator } from "@/lib/services";
import { type ProviderCheck, checkProvider } from "@hush/x402/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

interface Overview {
  credits: { agent: string; available: string; creditedTotal: string; settledCumulative: string; refundedTotal: string; expiresAt: number | null; frozen: boolean }[];
  topUps: { txHash: string; agent: string; payer: string; amount: string; createdAt: number }[];
  vouchers: { leaf: string; agent: string; amount?: string; resource?: string; batchId?: string | null; settledAt?: number }[];
  batches: { batchId: string; root: string; txHash: string; voucherCount: number; dummy: boolean; committedAt: number }[];
  refunds: { id: string; agent: string; amount: string; txHash: string | null; reason: string; status: string; createdAt: number }[];
  pendingIncoming?: unknown;
}

export function ProviderConsole() {
  const stack = useStack();
  const operatorUp = stack.health.operator === "up";
  const admin = stack.operator?.providerAdmin ?? false;
  const [bump, setBump] = useState(0);
  const overview = usePoll(() => (operatorUp && admin ? operator<Overview>("/provider/overview") : Promise.resolve(null)), 6_000, [operatorUp, admin, bump]);
  const [commit, setCommit] = useState<{ busy: boolean; msg?: string }>({ busy: false });
  const events = useAdminEvents(operatorUp && admin);
  const names: Record<string, string> = {};
  if (stack.targets) {
    names[stack.targets.atlas.toLowerCase()] = "Atlas";
    names[stack.targets.veil.toLowerCase()] = "Veil";
    if (stack.targets.owner) names[stack.targets.owner.toLowerCase()] = "Owner";
  }
  const who = (a: string) => names[a.toLowerCase()] ?? shortHex(a);

  const commitNow = async () => {
    setCommit({ busy: true });
    try {
      const r = await operator<{ batchId?: string; txHash?: string; busy?: boolean }>("/provider/commit", { method: "POST" });
      setCommit({ busy: false, msg: r.busy ? "a commit is already running" : `committed batch #${r.batchId}` });
      setBump((b) => b + 1);
    } catch (err) {
      setCommit({ busy: false, msg: (err as Error).message });
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-5 pb-24 pt-10 sm:px-8">
      <p className="kicker">Provider console</p>
      <h1 className="mt-6 font-display text-[clamp(2.6rem,5.5vw,4.4rem)] leading-[0.95]">
        Paid privately. <span className="text-seal">Accountable publicly.</span>
      </h1>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-dim">
        The provider decrypts its own top-ups and sees each agent&apos;s credit; the chain sees only ciphertext and the Merkle
        roots it commits on a fixed clock. Signal providers also commit a hash chain of every call to HushAlpha — a record
        anyone can verify, right here in the browser.
      </p>

      {/* wait until the stack has said which chain it runs on (the operator's /health) before verifying */}
      <AlphaSection
        chainId={stack.contracts.chainId}
        oracle={stack.contracts.stockOracle}
        hushAlpha={stack.contracts.hushAlpha}
        ready={stack.health.operator !== "checking"}
      />

      <div className="mt-10 flex flex-wrap items-center justify-between gap-4">
        <h2 className="font-display text-[2.2rem] leading-none">SignalCo&apos;s facilitator</h2>
        <div className="flex items-center gap-3">
          {commit.msg && <span className="font-mono text-[11px] text-ink-faint">{commit.msg}</span>}
          <Button tone="seal" disabled={!admin || commit.busy} onClick={() => void commitNow()}>
            {commit.busy ? "committing…" : "Commit batch now"}
          </Button>
        </div>
      </div>
      {!operatorUp ? (
        <Notice>The operator is offline — start the demo stack (`pnpm demo`) to see the provider&apos;s private view.</Notice>
      ) : !admin ? (
        <Notice>PROVIDER_ADMIN_TOKEN is not set in .env — the operator can&apos;t read the facilitator&apos;s admin API.</Notice>
      ) : (
        <div className="mt-4 grid gap-5 lg:grid-cols-2">
          <Panel title="Credit per agent · decrypted by the provider" aside={`${overview?.credits.length ?? 0} agents`}>
            {!overview?.credits.length ? (
              <Empty>no credit yet</Empty>
            ) : (
              <table className="w-full font-mono text-[11px]">
                <thead className="text-left text-ink-faint">
                  <tr>
                    <th className="pb-1.5 font-normal">agent</th>
                    <th className="pb-1.5 font-normal">credited</th>
                    <th className="pb-1.5 font-normal">spent</th>
                    <th className="pb-1.5 font-normal">available</th>
                    <th className="pb-1.5 font-normal">expires</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.credits.map((c) => (
                    <tr key={c.agent} className="border-t border-line">
                      <td className="py-1.5">
                        {who(c.agent)} {c.frozen && <span className="text-avax">frozen</span>}
                      </td>
                      <td>${usdc(c.creditedTotal)}</td>
                      <td>${usdc(c.settledCumulative, 4)}</td>
                      <td className="text-gold">${usdc(c.available, 4)}</td>
                      <td className="text-ink-faint">{c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Merkle batches → HushLedger" aside="padded when idle">
            {!overview?.batches.length ? (
              <Empty>no batches yet</Empty>
            ) : (
              <ol className="space-y-1.5 font-mono text-[11px]">
                {overview.batches.slice(0, 10).map((b) => (
                  <li key={b.batchId} className="grid grid-cols-[3.5rem_1fr_6rem_auto] gap-x-2">
                    <span className="text-ink-dim">#{b.batchId}</span>
                    <span className="truncate text-gold">{shortHex(b.root, 10, 6)}</span>
                    <span className={b.dummy ? "text-ink-faint" : "text-ink"}>{b.dummy ? "dummy" : `${b.voucherCount} vouchers`}</span>
                    <Tx hash={b.txHash} label="tx" />
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel title="Private top-ups · amounts decrypted with the provider key" aside={`${overview?.topUps.length ?? 0}`}>
            {!overview?.topUps.length ? (
              <Empty>no top-ups yet</Empty>
            ) : (
              <ol className="space-y-1.5 font-mono text-[11px]">
                {overview.topUps.slice(0, 8).map((t) => (
                  <li key={t.txHash} className="grid grid-cols-[4.2rem_1fr_auto_auto] gap-x-2">
                    <span className="text-ink-faint">{clock(t.createdAt)}</span>
                    <span>
                      {who(t.agent)}
                      {t.payer.toLowerCase() !== t.agent.toLowerCase() && <span className="text-ink-faint"> (paid by {who(t.payer)})</span>}
                    </span>
                    <span className="text-gold">${usdc(t.amount)} 🔓</span>
                    <Tx hash={t.txHash} label="tx" />
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel title="Live facilitator events" aside={<Dot state={events.live ? "live" : "offline"} />}>
            {events.rows.length === 0 ? (
              <Empty>waiting for activity…</Empty>
            ) : (
              <ol className="space-y-1.5 font-mono text-[11px]">
                {events.rows.slice(0, 12).map((e, i) => (
                  <li key={`${e.at}-${i}`} className="grid grid-cols-[4.2rem_1fr] gap-x-2">
                    <span className="text-ink-faint">{clock(e.at)}</span>
                    <span className="truncate text-ink-dim" title={e.text}>
                      {e.text}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      )}

      <DeskSection up={stack.health.desk === "up"} />
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="glass mt-4 rounded-[22px] px-5 py-4 font-mono text-[12px] text-ink-dim">{children}</p>;
}

function useAdminEvents(enabled: boolean) {
  const [rows, setRows] = useState<{ at: number; text: string }[]>([]);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource(`${SERVICES.operator}/provider/events`);
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (m: MessageEvent<string>) => {
      try {
        const e = JSON.parse(m.data) as { type?: string; at?: number; [k: string]: unknown };
        const { type, at, ...rest } = e;
        const detail = Object.entries(rest)
          .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
          .map(([k, v]) => `${k}=${typeof v === "string" && v.startsWith("0x") && v.length > 14 ? shortHex(v) : v}`)
          .join(" ");
        setRows((prev) => [{ at: at ?? Date.now(), text: `${type ?? "event"} ${detail}` }, ...prev].slice(0, 100));
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
  }, [enabled]);
  return { rows, live };
}

// ─── Proof of Alpha, verified in the browser ───
const PROVIDERS = [
  { url: SERVICES.provider, label: "SignalCo", blurb: "honest: publishes every call" },
  { url: SERVICES.alphaking, label: "AlphaKing", blurb: "“90%+ win rate. Trust us.”" },
];

function AlphaSection({ chainId, oracle, hushAlpha, ready }: { chainId: number; oracle?: `0x${string}`; hushAlpha?: `0x${string}`; ready: boolean }) {
  const [checks, setChecks] = useState<Record<string, ProviderCheck | "running" | undefined>>({});
  const [at, setAt] = useState<number>();
  const runId = useRef(0);
  const run = useCallback(async () => {
    if (!oracle || !ready) return;
    const id = ++runId.current;
    setChecks(Object.fromEntries(PROVIDERS.map((p) => [p.url, "running"])));
    const results = await Promise.all(
      PROVIDERS.map(
        async (p) =>
          [
            p.url,
            // Pin our HushAlpha deployment and chain: a proof names its own contract, which a provider could point anywhere.
            await checkProvider(p.url, { publicClient: clientFor(chainId), oracle, hushAlpha, chainId, policy: { minWinRate: 0.4, minCalls: 10 } }),
          ] as const,
      ),
    );
    if (id !== runId.current) return; // a newer run (e.g. after the chain was resolved) supersedes this one
    setChecks(Object.fromEntries(results));
    setAt(Date.now());
  }, [chainId, oracle, hushAlpha, ready]);
  useEffect(() => {
    void run();
  }, [run]);

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="font-display text-[2.2rem] leading-none">Proof of Alpha · signal providers</h2>
        <div className="flex items-center gap-3">
          {at && <span className="font-mono text-[11px] text-ink-faint">verified {ago(at)} against HushAlpha + the oracle</span>}
          <Button tone="gold" disabled={!oracle} onClick={() => void run()}>
            Verify again
          </Button>
        </div>
      </div>
      <div className="mt-4 grid gap-5 md:grid-cols-2">
        {PROVIDERS.map((p) => (
          <AlphaCard key={p.url} label={p.label} blurb={p.blurb} url={p.url} check={checks[p.url]} />
        ))}
      </div>
    </section>
  );
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);

function AlphaCard({ label, blurb, url, check }: { label: string; blurb: string; url: string; check: ProviderCheck | "running" | undefined }) {
  const c = check === "running" ? undefined : check;
  const r = c?.report;
  const failed = r && !r.valid;
  const tone = failed ? "border-t-avax/70" : r?.valid ? "border-t-gold/60" : "border-t-line-strong";
  return (
    <div className={`glass rounded-[22px] border-t-2 p-5 ${tone}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-display text-xl font-semibold">{label}</p>
        <span className="font-mono text-[10.5px] text-ink-faint">{url}</span>
      </div>
      <p className="text-[13px] text-ink-dim">{blurb}</p>
      {check === "running" ? (
        <Empty>verifying the chain heads…</Empty>
      ) : !c ? (
        <Empty>not checked</Empty>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">claims</p>
              <p className="font-display text-3xl font-semibold tabular-nums text-ink-dim">{pct(c.claims?.winRate)}</p>
              <p className="font-mono text-[10.5px] text-ink-faint">over {c.claims?.calls ?? 0} calls it chose to show</p>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">verified</p>
              <p className={`font-display text-3xl font-semibold tabular-nums ${failed ? "text-avax" : "text-gold"}`}>{failed ? "✗" : pct(r?.winRate)}</p>
              <p className="font-mono text-[10.5px] text-ink-faint">{r ? (r.valid ? `over ${r.calls} resolved calls` : `fails at epoch ${r.failedEpoch}`) : "no proof yet"}</p>
            </div>
          </div>
          <p className={`mt-4 text-[12.5px] leading-relaxed ${failed ? "text-avax" : c.passes ? "text-gold" : "text-ink-dim"}`}>{failed ? r!.reason : c.why}</p>
          {r?.valid && (
            <dl className="mt-3 grid grid-cols-[9rem_1fr] gap-y-1 font-mono text-[11px]">
              <dt className="text-ink-faint">epochs committed</dt>
              <dd>
                {r.committedEpochs}/{r.epochs}
                {r.gaps.length ? ` (${r.gaps.length} gaps)` : ""}
              </dd>
              <dt className="text-ink-faint">cumulative return</dt>
              <dd>{(r.pnlBps / 100).toFixed(2)}%</dd>
              <dt className="text-ink-faint">max drawdown</dt>
              <dd>{(r.maxDrawdownBps / 100).toFixed(2)}%</dd>
              <dt className="text-ink-faint">pending · unbound</dt>
              <dd>
                {r.pending} · {r.unbound}
              </dd>
            </dl>
          )}
        </>
      )}
    </div>
  );
}

// ─── Hush Desk ───
function DeskSection({ up }: { up: boolean }) {
  const inv = usePoll(() => getJson<{ ticker: string; custodied: string; privateInventory: string | null; publicInventory: string }[]>(`${SERVICES.desk}/inventory`), 10_000);
  const page = usePoll(() => getJson<{ desk: string }>(`${SERVICES.desk}/`), 30_000);
  return (
    <section className="mt-10">
      <h2 className="font-display text-[2.2rem] leading-none">Hush Desk</h2>
      <p className="mt-1 text-[13px] text-ink-dim">
        Custody is always backed by the desk&apos;s encrypted inventory, so every position can be settled out.{" "}
        {page?.desk && (
          <span className="font-mono text-[11px]">
            desk <Addr address={page.desk} />
          </span>
        )}
      </p>
      <div className="mt-4">
        <Panel title="Inventory per ticker" aside={up ? "live" : "desk offline"}>
          {!inv?.length ? (
            <Empty>{up ? "loading…" : "start the desk (`pnpm desk`)"}</Empty>
          ) : (
            <table className="w-full font-mono text-[11.5px]">
              <thead className="text-left text-ink-faint">
                <tr>
                  <th className="pb-1.5 font-normal">ticker</th>
                  <th className="pb-1.5 font-normal">custodied for agents</th>
                  <th className="pb-1.5 font-normal">encrypted inventory</th>
                  <th className="pb-1.5 font-normal">public inventory</th>
                </tr>
              </thead>
              <tbody>
                {inv.map((r) => (
                  <tr key={r.ticker} className="border-t border-line">
                    <td className="py-1.5">m{r.ticker}</td>
                    <td className="text-gold">{r.custodied}</td>
                    <td>{r.privateInventory ?? "—"}</td>
                    <td className="text-ink-dim">{r.publicInventory}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </section>
  );
}
