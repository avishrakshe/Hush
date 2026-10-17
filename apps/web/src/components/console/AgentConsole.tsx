"use client";

import { TelemetryList } from "@/components/demo/TelemetryList";
import { Addr, Button, Dot, Empty, Panel, Tx } from "@/components/demo/ui";
import { useAgentState, useKillSwitch, usePoll } from "@/components/demo/useDemoData";
import { useStack } from "@/components/demo/useStack";
import { type Viewer, useTelemetry } from "@/components/demo/useTelemetry";
import { shortHex } from "@/lib/chain";
import { clock, dollars, usdc } from "@/lib/format";
import { clientFor } from "@/lib/net";
import { AGENT_META, type AgentId, SERVICES, operator } from "@/lib/services";
import { type TradeReport, type TradeReportResult, formatPrice, formatShares, verifyTradeReport } from "@hush/x402/contracts";
import { useState } from "react";

interface Credit {
  available: string;
  creditedTotal: string;
  settledCumulative: string;
  refundedTotal: string;
  expiresAt: number | null;
  frozen: boolean;
}
interface Ledger {
  totals: { payments: number; spent: string; vouchers: number; receipts: number; refunds: number };
  payments: { id: string; scheme: string; amount: string; resource: string; at: number; kind?: string }[];
  vouchers: { leaf: string; amount: string; resource: string; status: string; verifiedOnChain?: boolean; inclusionFailed?: boolean; createdAt: number }[];
  receipts: { receipt: { topupTxHash: string; provider: string }; amount: string; createdAt: number }[];
}
interface Treasury {
  owner: string;
  publicUsdc: string;
  privateHusdc: string;
  agents: string[];
}
interface AuditEntry {
  timeUtc: string;
  kind: string;
  asset: string;
  from: string;
  to: string;
  amount: string | null;
  amountSource: string;
  txHash: string;
}

export function AgentConsole() {
  const stack = useStack();
  const [agent, setAgent] = useState<AgentId>("veil");
  const [viewer, setViewer] = useState<Exclude<Viewer, "raw">>("owner");
  const up = stack.health.operator === "up";
  const names: Record<string, string> = {};
  if (stack.targets) {
    for (const [k, v] of Object.entries(stack.targets)) if (v) names[v.toLowerCase()] = k === "provider" ? "SignalCo" : k.charAt(0).toUpperCase() + k.slice(1);
  }

  return (
    <div className="mx-auto max-w-7xl px-5 pb-24 pt-10 sm:px-8">
      <p className="kicker">Agent console · owner & auditor</p>
      <h1 className="mt-6 font-display text-[clamp(2.6rem,5.5vw,4.4rem)] leading-[0.95]">
        Private to the world. <span className="text-gold">Transparent to you.</span>
      </h1>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-dim">
        The owner&apos;s keys open everything the agent did — its sealed log, its credit, its signed vouchers and receipts,
        its desk-signed trades. The auditor&apos;s key opens every eERC amount on the contract. Keys stay in the local operator;
        the browser only ever sees the decrypted result.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-faint">Agent</span>
        {(["veil", "atlas"] as const).map((a) => (
          <Button key={a} pressed={agent === a} tone={a === "veil" ? "gold" : "leak"} onClick={() => setAgent(a)}>
            {AGENT_META[a].name}
          </Button>
        ))}
        <span className="ml-4 font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-faint">As</span>
        {(["owner", "auditor"] as const).map((v) => (
          <Button key={v} pressed={viewer === v} tone={v === "owner" ? "gold" : "seal"} onClick={() => setViewer(v)}>
            {v}
          </Button>
        ))}
      </div>

      {!up ? (
        <p className="glass mt-6 rounded-[22px] px-5 py-4 font-mono text-[12px] text-ink-dim">
          The operator is offline. Start the demo stack (`pnpm demo`, or `pnpm operator`) — it holds the owner and auditor keys
          on this machine so the browser never does.
        </p>
      ) : (
        <>
          <div className="mt-6 grid gap-5 lg:grid-cols-3">
            <StatusPanel agent={agent} stack={stack} />
            <CreditPanel agent={agent} />
            <TreasuryPanel />
          </div>
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <TradeReportPanel agent={agent} />
            <SealedLog agent={agent} viewer={viewer} />
          </div>
          <div className="mt-5">
            <LedgerPanel agent={agent} />
          </div>
          <div className="mt-5">
            <AuditorPanel names={names} />
          </div>
        </>
      )}
    </div>
  );
}

function StatusPanel({ agent, stack }: { agent: AgentId; stack: ReturnType<typeof useStack> }) {
  const kill = useKillSwitch(agent, true);
  const st = useAgentState(agent, "owner");
  const s = kill.status;
  const address = stack.targets?.[agent];
  return (
    <Panel title="Registry · kill switch" aside={<Dot state={stack.health[agent]} />}>
      <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-[12.5px]">
        <dt className="text-ink-faint">Address</dt>
        <dd className="font-mono text-[11.5px]">{address ? <Addr address={address} /> : "—"}</dd>
        <dt className="text-ink-faint">Registered</dt>
        <dd>{s ? (s.registered ? `yes${s.ownedByOperator ? ", owned by you" : ""}` : "no") : "…"}</dd>
        <dt className="text-ink-faint">Status</dt>
        <dd className={s?.frozen ? "text-avax" : "text-gold"}>{s ? (s.frozen ? "frozen — every facilitator rejects it" : "active") : "…"}</dd>
        <dt className="text-ink-faint">Position</dt>
        <dd className="font-mono text-[11.5px]">{st?.state?.position ? `${st.state.position.shares} ${st.state.ticker} @ $${st.state.position.avgCostUsd ?? "–"}` : "—"}</dd>
      </dl>
      <div className="mt-4 flex items-center gap-3">
        {s?.frozen ? (
          <Button disabled={kill.busy} onClick={() => void kill.toggle(false)}>
            Unfreeze
          </Button>
        ) : (
          <Button tone="danger" disabled={kill.busy || !s?.ownedByOperator} onClick={() => void kill.toggle(true)}>
            {kill.busy ? "…" : "Freeze agent"}
          </Button>
        )}
        {kill.error && <span className="font-mono text-[10.5px] text-leak">{kill.error}</span>}
      </div>
    </Panel>
  );
}

function CreditPanel({ agent }: { agent: AgentId }) {
  const credit = usePoll(() => operator<Credit>(`/agents/${agent}/credit`), 8_000, [agent]);
  return (
    <Panel title="Prepaid credit at SignalCo" aside="owner-signed query">
      {!credit ? (
        <Empty>no credit (or the facilitator is offline)</Empty>
      ) : (
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 font-mono text-[12px]">
          <dt className="font-sans text-ink-faint">Available</dt>
          <dd className="text-gold">${usdc(credit.available, 4)}</dd>
          <dt className="font-sans text-ink-faint">Credited</dt>
          <dd>${usdc(credit.creditedTotal)}</dd>
          <dt className="font-sans text-ink-faint">Spent</dt>
          <dd>${usdc(credit.settledCumulative, 4)}</dd>
          <dt className="font-sans text-ink-faint">Refunded</dt>
          <dd>${usdc(credit.refundedTotal)}</dd>
          <dt className="font-sans text-ink-faint">Expires</dt>
          <dd>{credit.expiresAt ? new Date(credit.expiresAt).toLocaleString() : "—"}</dd>
        </dl>
      )}
    </Panel>
  );
}

function TreasuryPanel() {
  const t = usePoll(() => operator<Treasury>("/treasury"), 15_000);
  return (
    <Panel title="Owner treasury" aside="decrypted locally">
      {!t ? (
        <Empty>loading…</Empty>
      ) : (
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 font-mono text-[12px]">
          <dt className="font-sans text-ink-faint">Owner</dt>
          <dd>
            <Addr address={t.owner} />
          </dd>
          <dt className="font-sans text-ink-faint">Private hUSDC</dt>
          <dd className="text-gold">${usdc(t.privateHusdc)}</dd>
          <dt className="font-sans text-ink-faint">Public USDC</dt>
          <dd>${usdc(t.publicUsdc)}</dd>
          <dt className="font-sans text-ink-faint">Agents</dt>
          <dd>{t.agents.length}</dd>
        </dl>
      )}
    </Panel>
  );
}

function SealedLog({ agent, viewer }: { agent: AgentId; viewer: Exclude<Viewer, "raw"> }) {
  const { rows, status } = useTelemetry(agent, viewer);
  return (
    <Panel
      title={`${AGENT_META[agent].name}'s log · ${agent === "veil" ? `unsealed as ${viewer}` : "plaintext"}`}
      aside={
        <span className="flex items-center gap-1.5">
          <Dot state={status} /> {status}
        </span>
      }
    >
      <TelemetryList rows={rows} limit={16} />
    </Panel>
  );
}

function TradeReportPanel({ agent }: { agent: AgentId }) {
  const [state, setState] = useState<{ busy: boolean; report?: TradeReport; result?: TradeReportResult; error?: string }>({ busy: false });
  const run = async () => {
    setState({ busy: true });
    try {
      const { report, oracle } = await operator<{ report: TradeReport; oracle: `0x${string}` | null }>(`/agents/${agent}/trade-report`);
      // Verified here, in the browser, against the chain — not by the operator that assembled it.
      const result = await verifyTradeReport(report, { publicClient: clientFor(report.chainId), oracle: oracle ?? undefined });
      setState({ busy: false, report, result });
    } catch (err) {
      setState({ busy: false, error: (err as Error).message });
    }
  };
  const download = () => {
    if (!state.report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(state.report, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `hush-trade-report-${agent}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const r = state.result;
  return (
    <Panel title="Proof of trading record · trade report" aside="verified in this browser">
      <p className="text-[12.5px] leading-relaxed text-ink-dim">
        Every desk-signed fill and statement, each fill tied to the voucher that paid for it and that voucher&apos;s Merkle proof
        on HushLedger. The desk numbers statements, so a hidden losing trade shows. Share the file with whoever you choose.
      </p>
      <div className="mt-3 flex gap-3">
        <Button tone="gold" disabled={state.busy} onClick={() => void run()}>
          {state.busy ? "verifying…" : "Build & verify"}
        </Button>
        {state.report && <Button onClick={download}>Download report</Button>}
      </div>
      {state.error && <p className="mt-3 font-mono text-[11px] text-leak">{state.error}</p>}
      {r && (
        <div className="mt-4">
          <div className="flex flex-wrap gap-2 font-mono text-[10.5px] uppercase tracking-[0.14em]">
            <Badge ok={r.valid}>{r.valid ? "signatures valid" : "invalid"}</Badge>
            <Badge ok={r.complete}>{r.complete ? "complete record" : "incomplete"}</Badge>
            <Badge ok={r.committedOnChain > 0 || r.fills === 0}>
              {r.committedOnChain}/{r.fills} anchored on-chain
            </Badge>
          </div>
          {(r.reason || r.incompleteBecause) && <p className="mt-2 font-mono text-[11px] text-leak">{r.reason ?? r.incompleteBecause}</p>}
          <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-y-1 font-mono text-[11.5px]">
            <dt className="font-sans text-ink-faint">Trades</dt>
            <dd>
              {r.buys} buys · {r.sells} sells · {r.settleOuts} settle-outs · statements 1…{r.lastSeq}
            </dd>
            <dt className="font-sans text-ink-faint">Bought · sold</dt>
            <dd>
              {dollars(r.boughtNotional)} · {dollars(r.soldNotional)}
            </dd>
            <dt className="font-sans text-ink-faint">Realized P&L</dt>
            <dd className={BigInt(r.realizedPnl) < 0n ? "text-leak" : "text-gold"}>{dollars(r.realizedPnl)}</dd>
            <dt className="font-sans text-ink-faint">Unrealized</dt>
            <dd>{r.unrealizedPnl === null ? "—" : dollars(r.unrealizedPnl)}</dd>
          </dl>
          {r.tickers.length > 0 && (
            <ul className="mt-3 space-y-1 font-mono text-[11px] text-ink-dim">
              {r.tickers.map((t) => (
                <li key={t.ticker}>
                  {t.ticker}: {formatShares(BigInt(t.position))} sh @ ${formatPrice(BigInt(t.avgCost))}
                  {t.mark && ` · mark $${formatPrice(BigInt(t.mark))}`} · {t.matchesDesk ? "matches the desk's last statement ✓" : "≠ desk statement"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={`rounded-full px-2.5 py-1 ${ok ? "bg-gold/10 text-gold" : "bg-avax/15 text-avax"}`}>{children}</span>;
}

function LedgerPanel({ agent }: { agent: AgentId }) {
  const [bump, setBump] = useState(0);
  const ledger = usePoll(() => operator<Ledger>(`/agents/${agent}/ledger`), 8_000, [agent, bump]);
  const [verify, setVerify] = useState<{ busy: boolean; text?: string }>({ busy: false });
  const run = async () => {
    setVerify({ busy: true });
    try {
      const r = await operator<{ vouchers: { verified: number; pending: number; failed: number }; receipts: { valid: number; invalid: number } }>(`/agents/${agent}/verify`, { method: "POST" });
      setVerify({
        busy: false,
        text: `vouchers: ${r.vouchers.verified} in HushLedger roots, ${r.vouchers.pending} awaiting a batch, ${r.vouchers.failed} failed · receipts: ${r.receipts.valid} valid, ${r.receipts.invalid} invalid`,
      });
      setBump((b) => b + 1);
    } catch (err) {
      setVerify({ busy: false, text: (err as Error).message });
    }
  };
  return (
    <Panel title="The agent's own ledger · vouchers and receipts" aside={ledger ? `${ledger.totals.vouchers} vouchers · ${ledger.totals.receipts} top-ups` : ""}>
      <div className="flex flex-wrap items-center gap-3">
        <Button tone="gold" disabled={verify.busy} onClick={() => void run()}>
          {verify.busy ? "checking…" : "Verify against HushLedger"}
        </Button>
        {verify.text && <span className="font-mono text-[11px] text-ink-dim">{verify.text}</span>}
      </div>
      {!ledger?.vouchers.length ? (
        <Empty>no vouchers yet</Empty>
      ) : (
        <div className="mt-4 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <ol className="space-y-1.5 font-mono text-[11px]">
            {ledger.vouchers.slice(0, 12).map((v) => (
              <li key={v.leaf} className="grid grid-cols-[4.2rem_6rem_1fr_auto] gap-x-2">
                <span className="text-ink-faint">{clock(v.createdAt)}</span>
                <span>${usdc(v.amount, 4)}</span>
                <span className="truncate text-ink-dim" title={v.resource}>
                  {v.resource.startsWith("hush-rfq") ? `desk ${v.resource.includes(":sell:") ? "sell order" : "buy"}` : v.resource.replace(/^https?:\/\/[^/]+/, "")}
                </span>
                <span className={v.inclusionFailed ? "text-avax" : v.verifiedOnChain ? "text-gold" : "text-ink-faint"}>
                  {v.inclusionFailed ? "✗ not in root" : v.verifiedOnChain ? "✓ in root" : v.status}
                </span>
              </li>
            ))}
          </ol>
          <ol className="space-y-1.5 font-mono text-[11px]">
            {ledger.receipts.slice(0, 8).map((r) => (
              <li key={r.receipt.topupTxHash} className="grid grid-cols-[4.2rem_1fr_auto] gap-x-2">
                <span className="text-ink-faint">{clock(r.createdAt)}</span>
                <span>
                  top-up ${usdc(r.amount)} → {shortHex(r.receipt.provider)} <span className="text-gold">signed receipt</span>
                </span>
                <Tx hash={r.receipt.topupTxHash} label="tx" />
              </li>
            ))}
          </ol>
        </div>
      )}
    </Panel>
  );
}

function AuditorPanel({ names }: { names: Record<string, string> }) {
  const audit = usePoll(() => operator<{ scannedTo: string; count: number; entries: AuditEntry[] }>("/audit/transfers"), 20_000);
  const who = (a: string) => names[a.toLowerCase()] ?? shortHex(a);
  return (
    <Panel
      title="Auditor view · every eERC movement on the contract"
      aside={
        <a href={`${SERVICES.operator}/audit/export.csv`} className="text-seal underline underline-offset-2 hover:text-ink">
          download CSV
        </a>
      }
    >
      <p className="text-[12.5px] text-ink-dim">
        Deposits are public; transfers and withdrawals carry the amount encrypted to the auditor key that was set at the time.
        {audit && ` ${audit.count} events, indexed to block ${audit.scannedTo}.`}
      </p>
      {!audit?.entries.length ? (
        <Empty>indexing…</Empty>
      ) : (
        <ol className="mt-3 space-y-1.5 font-mono text-[11px]">
          {audit.entries.slice(0, 14).map((e) => (
            <li key={`${e.txHash}-${e.kind}-${e.from}`} className="grid grid-cols-[4.2rem_4.5rem_1fr_7rem_auto] gap-x-2">
              <span className="text-ink-faint">{clock(Date.parse(e.timeUtc))}</span>
              <span className="text-ink-dim">{e.kind}</span>
              <span className="truncate">
                {who(e.from)} → {who(e.to)}
              </span>
              <span className={e.amountSource.startsWith("public") ? "text-ink" : "text-seal"} title={e.amountSource}>
                {e.amount ?? "?"} {e.asset}
              </span>
              <Tx hash={e.txHash} label="tx" />
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
