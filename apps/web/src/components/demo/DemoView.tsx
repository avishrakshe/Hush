"use client";

import { shortHex } from "@/lib/chain";
import { clock } from "@/lib/format";
import { isLocal } from "@/lib/net";
import { AGENT_META, type AgentId, SERVICES, type ServiceName } from "@/lib/services";
import { useMemo, useState } from "react";
import { ChainList, Footprint, PrivacyMeter, leakItems } from "./Observer";
import { TelemetryList } from "./TelemetryList";
import { type ChainFeed, useChainFeed } from "./useChainFeed";
import { type AgentState, type MirrorState, useAgentState, useDecrypted, useKillSwitch, useMirror } from "./useDemoData";
import { type Stack, useStack } from "./useStack";
import { type Viewer, useTelemetry } from "./useTelemetry";
import { Addr, Button, Dot, Empty, Panel, Tx, useNow } from "./ui";

const VIEWERS: { id: Viewer; label: string; hint: string }[] = [
  { id: "raw", label: "Public", hint: "what anyone sees: the chain and the agents' raw streams" },
  { id: "owner", label: "Owner", hint: "decrypted with the owner's eERC key (via the local operator)" },
  { id: "auditor", label: "Auditor", hint: "decrypted with eERC's auditor key (via the local operator)" },
];

export function DemoView() {
  const stack = useStack();
  const feed = useChainFeed(stack.targets, stack.contracts);
  const mirror = useMirror();
  const [viewer, setViewer] = useState<Viewer>("raw");
  const operatorUp = stack.health.operator === "up";
  const names = useMemo(() => nameMap(stack), [stack]);

  return (
    <div className="mx-auto max-w-7xl px-5 pb-24 pt-10 sm:px-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <p className="kicker">Live demo · {isLocal(stack.contracts) ? "local hardhat chain" : "Avalanche Fuji"}</p>
          <h1 className="mt-6 font-display text-[clamp(2.6rem,5.5vw,4.6rem)] leading-[0.95]">
            Same strategy. <span className="text-leak">One leaks.</span> <span className="text-gold">One doesn&apos;t.</span>
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-ink-dim">
            Atlas and Veil run the same loop: buy a signal, decide, trade mock stocks at the Hush Desk. Atlas pays with public
            x402; Veil uses Hush. Mirror, a copycat bot, reads the chain and copies every trade it can see. Everything below is
            read live from {isLocal(stack.contracts) ? "the local chain" : "Fuji"} and the agents&apos; own streams.
          </p>
        </div>
        <StackStrip stack={stack} feed={feed} />
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-faint">View as</span>
        {VIEWERS.map((v) => (
          <Button key={v.id} pressed={viewer === v.id} tone={v.id === "raw" ? "default" : v.id === "owner" ? "gold" : "seal"} disabled={v.id !== "raw" && !operatorUp} onClick={() => setViewer(v.id)}>
            {v.label}
          </Button>
        ))}
        <span className="font-mono text-[11px] text-ink-faint">{VIEWERS.find((v) => v.id === viewer)!.hint}</span>
        {!operatorUp && <span className="font-mono text-[11px] text-leak">operator offline — owner/auditor views need `pnpm operator`</span>}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <AgentColumn agent="atlas" stack={stack} feed={feed} viewer={viewer} names={names} />
        <AgentColumn agent="veil" stack={stack} feed={feed} viewer={viewer} names={names} />
      </div>

      <MirrorPanel mirror={mirror} up={stack.health.mirror === "up"} />

      <BatchStrip feed={feed} names={names} />
    </div>
  );
}

function nameMap(stack: Stack): Record<string, string> {
  const t = stack.targets;
  const out: Record<string, string> = {};
  if (!t) return out;
  const add = (a: string | undefined, n: string) => a && (out[a.toLowerCase()] = n);
  add(t.atlas, "Atlas");
  add(t.veil, "Veil");
  add(t.provider, "SignalCo");
  add(t.desk, "Desk");
  add(t.alphaking, "AlphaKing");
  add(t.mirror, "Mirror");
  add(t.owner, "Owner");
  return out;
}

function StackStrip({ stack, feed }: { stack: Stack; feed: ChainFeed }) {
  const order: ServiceName[] = ["facilitator", "provider", "alphaking", "desk", "mirror", "operator", "atlas", "veil"];
  return (
    <div className="glass rounded-[22px] px-4 py-3">
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[10.5px] text-ink-dim sm:grid-cols-4">
        {order.map((n) => (
          <li key={n} className="flex items-center gap-1.5" title={SERVICES[n]}>
            <Dot state={stack.health[n]} /> {n}
          </li>
        ))}
      </ul>
      <p className="mt-2 border-t border-line pt-2 font-mono text-[10.5px] text-ink-faint">
        block {feed.block?.toString() ?? "…"} {feed.error ? <span className="text-leak">· rpc: {feed.error}</span> : null}
      </p>
    </div>
  );
}

function AgentColumn({ agent, stack, feed, viewer, names }: { agent: AgentId; stack: Stack; feed: ChainFeed; viewer: Viewer; names: Record<string, string> }) {
  const meta = AGENT_META[agent];
  const now = useNow(5_000);
  const rows = feed[agent];
  const items = leakItems(agent, rows);
  const telemetryViewer: Viewer = agent === "atlas" ? "raw" : viewer;
  const { rows: events, status } = useTelemetry(agent, telemetryViewer);
  const st = useAgentState(agent, viewer);
  const decrypted = useDecrypted(agent === "veil" ? rows : [], viewer);
  const kill = useKillSwitch(agent, stack.health.operator === "up");
  const accent = agent === "atlas" ? "leak" : "gold";
  const address = stack.targets?.[agent];

  return (
    <article className="flex flex-col gap-4">
      <header className={`glass rounded-[22px] border-t-2 p-5 ${agent === "atlas" ? "border-t-leak/60" : "border-t-gold/60"}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-[2.2rem] leading-none">
              {meta.name} <span className={`ml-1 font-mono text-[11px] uppercase tracking-[0.16em] ${agent === "atlas" ? "text-leak" : "text-gold"}`}>{meta.scheme}</span>
            </h2>
            <p className="mt-1 text-sm text-ink-dim">{meta.blurb}</p>
            <p className="mt-2 flex items-center gap-2 font-mono text-[11px] text-ink-faint">
              <Dot state={stack.health[agent]} /> {stack.health[agent] === "up" ? "running" : "not running"}
              {address && (
                <>
                  · <Addr address={address} />
                </>
              )}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {kill.status?.frozen ? (
              <>
                <span className="rounded-full bg-avax/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-avax">frozen</span>
                <Button tone="default" disabled={kill.busy} onClick={() => void kill.toggle(false)}>
                  Unfreeze
                </Button>
              </>
            ) : (
              <Button tone="danger" disabled={kill.busy || !kill.status?.ownedByOperator} onClick={() => void kill.toggle(true)}>
                {kill.busy ? "…" : "Kill switch"}
              </Button>
            )}
            {kill.error && <span className="max-w-[12rem] text-right font-mono text-[10px] text-leak">{kill.error}</span>}
          </div>
        </div>
        <div className="mt-5">
          <PrivacyMeter items={items} accent={accent} />
        </div>
      </header>

      <Panel title="On-chain footprint · last 30 min" aside={`${rows.filter((r) => r.at >= now - 30 * 60_000).length} events`}>
        <Footprint rows={rows} batches={feed.batches} now={now} agent={agent} />
      </Panel>

      <Panel title="What the chain shows" aside={agent === "veil" && viewer !== "raw" ? `amounts 🔓 as ${viewer}` : "anyone can read this"}>
        <ChainList rows={rows} decrypted={decrypted} names={names} />
      </Panel>

      <Panel
        title={agent === "veil" ? "The agent's own log · sealed to owner + auditor" : "The agent's own log · plaintext"}
        aside={
          <span className="flex items-center gap-1.5">
            <Dot state={status} /> {status}
          </span>
        }
      >
        <TelemetryList rows={events} />
      </Panel>

      <Panel title="Position & budget" aside={st?.sealed ? (viewer === "raw" ? "sealed" : `🔓 as ${viewer}`) : "public"}>
        <AgentStateView state={st?.state ?? null} sealed={!!st?.sealed} viewer={viewer} />
      </Panel>
    </article>
  );
}

function AgentStateView({ state, sealed, viewer }: { state: AgentState | null; sealed: boolean; viewer: Viewer }) {
  if (sealed && viewer === "raw") return <Empty>🔒 sealed — switch to Owner or Auditor to open it</Empty>;
  if (!state) return <Empty>no state yet</Empty>;
  const kv: [string, string | undefined][] = [
    ["Position", state.position ? `${state.position.shares} ${state.ticker ?? ""} (max ${state.position.maxShares})` : undefined],
    ["Avg cost · mark", state.position?.avgCostUsd ? `$${state.position.avgCostUsd} · $${state.markUsd}` : state.markUsd ? `— · $${state.markUsd}` : undefined],
    ["Unrealized P&L", state.position?.unrealizedPnlUsd != null ? `$${state.position.unrealizedPnlUsd}` : undefined],
    ["Cash", state.cashUsd ? `$${state.cashUsd}` : undefined],
    ["Data spend today", state.budget ? `$${state.budget.dataSpentTodayUsd} / $${state.budget.dataDailyCapUsd}` : undefined],
    ["Traded today", state.budget ? `$${state.budget.tradedTodayUsd} / $${state.budget.tradeDailyCapUsd}` : undefined],
    ["Last decision", state.lastDecision ? `${state.lastDecision.action}${state.lastDecision.shares ? ` ${state.lastDecision.shares}` : ""} — ${state.lastDecision.rationale}` : undefined],
  ];
  return (
    <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
      {kv
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-faint">{k}</dt>
            <dd className="truncate font-mono text-[11.5px] text-ink" title={v}>
              {v}
            </dd>
          </div>
        ))}
    </dl>
  );
}

function MirrorPanel({ mirror, up }: { mirror: MirrorState | null; up: boolean }) {
  const recent = [...(mirror?.recent ?? [])].reverse().slice(0, 10);
  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-[2.2rem] leading-none">
          Mirror <span className="ml-1 font-mono text-[11px] uppercase tracking-[0.16em] text-avax">copycat bot</span>
        </h2>
        <p className="font-mono text-[11px] text-ink-faint">
          <Dot state={up ? "up" : "down"} /> reads public chain data only · copies every trade it can infer
        </p>
      </div>
      {!mirror ? (
        <div className="glass mt-4 rounded-[22px]">
          <Empty>{up ? "loading…" : "Mirror is not running (`pnpm mirror`)"}</Empty>
        </div>
      ) : (
        <div className="mt-4 grid gap-5 lg:grid-cols-[1.3fr_1fr]">
          <div className="grid gap-4 sm:grid-cols-2">
            {(["Atlas", "Veil"] as const).map((label) => {
              const t = mirror.targets.find((x) => x.label.toLowerCase() === label.toLowerCase());
              const pub = t?.kind === "public";
              // Until a target trades publicly Mirror has only seen signal purchases or encrypted transfers.
              const verdict = t?.kind === "unknown" ? "watching — no trade seen yet" : t?.verdict;
              const accent = label === "Atlas" ? "text-leak" : "text-gold";
              return (
                <div key={label} className={`glass rounded-[22px] p-5 ${label === "Atlas" ? "border-t-2 border-t-leak/50" : "border-t-2 border-t-gold/50"}`}>
                  <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-dim">Mirror vs {label}</p>
                  <p className={`mt-3 font-display text-4xl font-semibold tabular-nums ${accent}`}>
                    {t ? `${t.tradesCopied}/${t.tradesSeen}` : "0/0"}
                  </p>
                  <p className="text-[12.5px] text-ink-dim">trades copied / trades seen</p>
                  <dl className="mt-4 grid grid-cols-[7.5rem_1fr] gap-y-1 font-mono text-[11px]">
                    <dt className="text-ink-faint">avg lag</dt>
                    <dd>{t?.avgLagSec != null ? `${t.avgLagSec}s after the trade` : "—"}</dd>
                    <dt className="text-ink-faint">{label}&apos;s P&L</dt>
                    <dd>{t?.targetPnlUsd != null ? `$${Number(t.targetPnlUsd).toFixed(4)}` : pub ? "—" : "unknown to Mirror"}</dd>
                    <dt className="text-ink-faint">copy P&L</dt>
                    <dd>{t ? `$${Number(t.copiedPnlUsd).toFixed(4)}` : "—"}</dd>
                  </dl>
                  <p className="mt-3 text-[12px] leading-relaxed text-ink-dim">{verdict ?? (label === "Veil" ? "nothing seen yet — no public trades to infer" : "waiting for Atlas's first trade")}</p>
                  {t && t.sees.length > 0 && (
                    <ul className="mt-2 space-y-0.5 font-mono text-[10.5px] text-ink-faint">
                      {t.sees.slice(0, 4).map((x) => (
                        <li key={x} className="truncate" title={x}>
                          · {x}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
          <Panel title="Mirror's log" aside={`${mirror.totals.tradesCopied} copies · avg lag ${mirror.totals.avgLagSec ?? "–"}s`}>
            {recent.length === 0 ? (
              <Empty>watching…</Empty>
            ) : (
              <ol className="space-y-1.5 font-mono text-[11px]">
                {recent.map((e) => (
                  <li key={e.id} className="grid grid-cols-[4.2rem_1fr_auto] gap-x-2">
                    <span className="text-ink-faint">{clock(e.at)}</span>
                    <span className={`truncate ${e.type === "copied" ? "text-leak" : e.kind === "private" ? "text-gold" : "text-ink-dim"}`}>
                      {e.type === "copied"
                        ? `copied ${e.target}: ${e.side} ${e.shares} ${e.ticker} @ $${e.price} (+${e.lagSec}s)`
                        : e.type === "observed"
                          ? e.kind === "public-trade"
                            ? `saw ${e.target} ${e.side} ${e.shares} ${e.ticker}`
                            : e.kind === "signal-purchase"
                              ? `saw ${e.target} buy a signal ($${e.amount})`
                              : `${e.target}: ${e.what}`
                          : `${e.type} ${e.target ?? ""} ${e.reason ?? e.error ?? ""}`}
                    </span>
                    {e.tx ? <Tx hash={e.tx} label="tx" /> : <span />}
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      )}
    </section>
  );
}

function BatchStrip({ feed, names }: { feed: ChainFeed; names: Record<string, string> }) {
  return (
    <section className="mt-8">
      <Panel title="Merkle batch roots on HushLedger · fixed cadence (2 min on Fuji), empty batches included" aside={`${feed.batches.length} in view`}>
        {feed.batches.length === 0 ? (
          <Empty>no batch committed in view yet</Empty>
        ) : (
          <ol className="grid gap-x-6 gap-y-1.5 font-mono text-[11px] md:grid-cols-2">
            {feed.batches.slice(0, 10).map((b) => (
              <li key={b.key} className="grid grid-cols-[4.2rem_5rem_1fr_auto] gap-x-2">
                <span className="text-ink-faint">{clock(b.at)}</span>
                <span className="text-ink-dim">{names[b.from?.toLowerCase() ?? ""] ?? shortHex(b.from ?? "")}</span>
                <span className="truncate text-gold">
                  #{b.batchId?.toString()} {shortHex(b.root ?? "", 10, 6)}
                </span>
                <Tx hash={b.txHash} label="tx" />
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </section>
  );
}
