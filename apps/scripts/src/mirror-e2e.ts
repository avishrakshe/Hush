/**
 * V3 check: Mirror (the copycat) against a public trader (Atlas) and a Hush trader (Veil).
 *
 *   Atlas buys and sells publicly → Mirror infers ticker/size/direction from public transfers and copies both, with lag
 *   Atlas buys a signal → Mirror sees it · Veil buys a signal and trades privately → Mirror sees encrypted transfers
 *   (addresses + asset) and has nothing to copy
 *
 * Usage: pnpm mirror-e2e[:local]   (needs price-bot, facilitator, provider, desk and `pnpm mirror[:local]` running)
 */
import { NETWORK, URLS, loadContracts, publicClient, txLink, wallet } from "@hush/config";
import { formatShares, mockStockAbi } from "@hush/x402";
import { HushDeskClient, HushPublicDesk, createHushFetch } from "@hush/x402/client";

const contracts = loadContracts();
const MIRROR = process.env.MIRROR_URL || `http://localhost:${process.env.MIRROR_PORT || 4033}`;
const atlas = wallet("ATLAS");
const veil = wallet("VEIL");
const mirrorAddr = wallet("MIRROR").address;

interface MirrorTarget {
  address: string;
  label: string;
  kind: string;
  tradesSeen: number;
  tradesCopied: number;
  avgLagSec: number | null;
  targetPnlUsd: string | null;
  copiedPnlUsd: string;
  verdict: string;
  sees: string[];
}
interface MirrorState {
  totals: { tradesCopied: number; avgLagSec: number | null; copiedPnlUsd: string };
  targets: MirrorTarget[];
}

const results: { check: string; result: "PASS" | "FAIL"; detail: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function check(name: string, fn: () => Promise<string>) {
  process.stdout.write(`▸ ${name} … `);
  try {
    const detail = await fn();
    results.push({ check: name, result: "PASS", detail });
    console.log(`PASS  ${detail}`);
  } catch (err) {
    const detail = (err as Error).message.split("\n")[0]!.slice(0, 200);
    results.push({ check: name, result: "FAIL", detail });
    console.log(`FAIL  ${detail}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const mirrorState = async () => (await (await fetch(`${MIRROR}/state`)).json()) as MirrorState;
const targetOf = (s: MirrorState, address: string) => s.targets.find((t) => t.address.toLowerCase() === address.toLowerCase());
async function waitFor<T>(fn: () => Promise<T | undefined>, what: string, timeoutMs = 90_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(2_000);
  }
}
const mirrorHolds = () => publicClient.readContract({ address: contracts.stocks!.NVDA!, abi: mockStockAbi, functionName: "balanceOf", args: [mirrorAddr] });

async function main() {
  console.log(`Hush V3 Mirror e2e on ${NETWORK} · mirror ${MIRROR}\n`);
  const atlasPay = createHushFetch({ mode: "public", wallet: atlas.account, publicClient: publicClient as never });
  const atlasDesk = new HushPublicDesk({ deskUrl: URLS.desk, pay: atlasPay, walletClient: atlas.walletClient, publicClient: publicClient as never, contracts });
  const veilPay = createHushFetch({
    mode: "hush-credit",
    wallet: veil.account,
    eercClient: await veil.eerc(contracts).init(),
    publicClient: publicClient as never,
    privacy: { topUpChunks: [20_000_000n], jitterMs: [0, 0] },
  });
  const veilDesk = new HushDeskClient({ deskUrl: URLS.desk, hush: veilPay, signer: veil.account });

  await check("Mirror is watching the desk and the signal provider", async () => {
    const h = (await (await fetch(`${MIRROR}/health`)).json()) as { desk: string; provider: string };
    return `desk ${h.desk.slice(0, 8)}… · provider ${h.provider.slice(0, 8)}…`;
  });

  let before = 0n;
  let atlasCopiesBefore = 0;
  await check("Atlas buys 0.05 NVDA publicly → Mirror infers it from the chain and copies it", async () => {
    before = await mirrorHolds();
    atlasCopiesBefore = targetOf(await mirrorState(), atlas.address)?.tradesCopied ?? 0;
    const t = await atlasDesk.buy("NVDA", "0.05");
    const target = await waitFor(async () => {
      const x = targetOf(await mirrorState(), atlas.address);
      return x && x.tradesCopied > atlasCopiesBefore ? x : undefined;
    }, "Mirror to copy Atlas's buy");
    const gained = (await mirrorHolds()) - before;
    assert(gained === 5n * 10n ** 16n, `Mirror's mNVDA changed by ${gained}`);
    return `Atlas paid ${txLink(t.paymentTx)} · Mirror (${target.label}) copied +0.05 mNVDA, avg lag ${target.avgLagSec}s`;
  });

  await check("Atlas sells 0.05 NVDA publicly → Mirror copies the sell too", async () => {
    const copied = targetOf(await mirrorState(), atlas.address)?.tradesCopied ?? 0;
    const t = await atlasDesk.sell("NVDA", "0.05");
    await waitFor(async () => {
      const x = targetOf(await mirrorState(), atlas.address);
      return x && x.tradesCopied > copied ? x : undefined;
    }, "Mirror to copy Atlas's sell");
    const now = await mirrorHolds();
    assert(now === before, `Mirror holds ${now}, expected back to ${before}`);
    return `Atlas's sell ${txLink(t.transferTx ?? t.paymentTx)} copied — Mirror flat again`;
  });

  await check("Atlas buys a signal publicly → Mirror sees the purchase (a trade usually follows)", async () => {
    const res = await atlasPay.fetch(`${URLS.provider}/api/signal?ticker=NVDA`);
    assert(res.ok, `signal → ${res.status}`);
    const t = await waitFor(async () => {
      const x = targetOf(await mirrorState(), atlas.address);
      return x?.sees.some((s) => s.startsWith("signal purchases")) ? x : undefined;
    }, "Mirror to see the signal purchase");
    return `Mirror sees for Atlas: ${t.sees.join(" · ")}`;
  });

  await check("Veil buys a signal and 0.05 NVDA privately → Mirror has nothing to copy", async () => {
    const res = await veilPay.fetch(`${URLS.provider}/api/signal?ticker=NVDA`);
    assert(res.ok, `signal → ${res.status}`);
    const holdsBefore = await mirrorHolds();
    const copiesBefore = (await mirrorState()).totals.tradesCopied;
    const fill = await veilDesk.buy("NVDA", "0.05");
    await sleep(15_000); // give Mirror several polls
    const s = await mirrorState();
    const v = targetOf(s, veil.address);
    assert(s.totals.tradesCopied === copiesBefore, `Mirror copied ${s.totals.tradesCopied - copiesBefore} trades during Veil's buy`);
    assert((await mirrorHolds()) === holdsBefore, "Mirror's holdings moved");
    assert(!v || (v.tradesSeen === 0 && v.kind !== "public"), `Mirror classified Veil as ${v?.kind} with ${v?.tradesSeen} trades`);
    return `Veil position ${formatShares(fill.statement.position)} (desk-signed) · Mirror: ${v ? `${v.verdict} · sees: ${v.sees.join(" · ") || "nothing"}` : "never saw Veil at all"}`;
  });

  await check("Mirror's scoreboard: copies, lag and P&L for Atlas; 'nothing to copy' for Veil", async () => {
    const s = await mirrorState();
    const a = targetOf(s, atlas.address);
    assert(a && a.kind === "public" && a.tradesCopied >= 2, "Atlas not tracked as a copied public trader");
    const v = targetOf(s, veil.address);
    return `Atlas: ${a.verdict}, Atlas P&L $${a.targetPnlUsd}, Mirror's copy P&L $${a.copiedPnlUsd} · Veil: ${v?.verdict ?? "unseen"}`;
  });

  veilPay.credit?.stop();
  console.log();
  console.table(results.map(({ check, result }) => ({ check, result })));
  const failed = results.filter((r) => r.result === "FAIL").length;
  console.log(failed ? `${failed} check(s) FAILED` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
