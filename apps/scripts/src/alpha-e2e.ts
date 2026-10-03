/**
 * V4 check: Proof of Alpha for signal providers.
 *
 *   SignalCo (honest) and AlphaKing (cherry-picks) both publish signed calls and commit a chain head to HushAlpha every
 *   epoch. SignalCo's proof verifies and its claims match; AlphaKing's claims look great but its proof fails at the first
 *   epoch it doctored. Tampering is caught, proofs never reveal live calls, a call bought with hush-credit shows up in
 *   the provider's proof, and the SDK's provider choice (what Veil runs) picks SignalCo.
 *
 * Usage: pnpm alpha-e2e[:local]   (needs price-bot, facilitator and provider running; calls must resolve first —
 * locally ~5 min with 60 s epochs, on Fuji ~40 min with 600 s epochs)
 */
import { NETWORK, URLS, loadContracts, publicClient, wallet } from "@hush/config";
import {
  type AlphaProof,
  type ProofReport,
  type ProviderAlphaInfo,
  type SignalRecordJson,
  alphaDomain,
  chooseProvider,
  hushAlphaAbi,
  signalFromJson,
  signalTyped,
  verifyProof,
} from "@hush/x402";
import { createHushFetch } from "@hush/x402/client";
import type { Address, Hex } from "viem";

const contracts = loadContracts();
if (!contracts.hushAlpha || !contracts.stockOracle) throw new Error("this deployment has no HushAlpha / stock oracle");
const hushAlpha = contracts.hushAlpha;
const MIN_CALLS = Number(process.env.ALPHA_E2E_MIN_CALLS || 5);
const TIMEOUT_MS = Number(process.env.ALPHA_E2E_TIMEOUT_SECONDS || (NETWORK === "localhost" ? 600 : 3600)) * 1000;
const verifyOpts = { publicClient: publicClient as never, oracle: contracts.stockOracle };
const SIGNALCO = URLS.provider;
const ALPHAKING = URLS.alphaking;

const results: { check: string; result: "PASS" | "FAIL"; detail: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function check(name: string, fn: () => Promise<string>) {
  process.stdout.write(`▸ ${name} … `);
  try {
    const detail = await fn();
    results.push({ check: name, result: "PASS", detail });
    console.log(`PASS  ${detail}`);
  } catch (err) {
    const detail = (err as Error).message.split("\n")[0]!.slice(0, 220);
    results.push({ check: name, result: "FAIL", detail });
    console.log(`FAIL  ${detail}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
async function waitFor<T>(fn: () => Promise<T | undefined>, what: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const t0 = Date.now();
  let last = 0;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    if (Date.now() - last > 60_000) {
      process.stdout.write(`\n    (waiting for ${what}, ${Math.round((Date.now() - t0) / 1000)} s) `);
      last = Date.now();
    }
    await sleep(5_000);
  }
}

const getJson = async <T>(url: string) => (await (await fetch(url)).json()) as T;
const pageOf = (base: string) => getJson<{ name: string; proofOfAlpha?: ProviderAlphaInfo & { lastCommittedEpoch: string } }>(`${base}/`);
const proofOf = (base: string, query = "") => getJson<AlphaProof & { error?: string }>(`${base}/proof-of-alpha${query}`);
const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const summary = (r: ProofReport) =>
  `verified ${pct(r.winRate)} over ${r.calls} calls (${r.records} records, epochs ${r.fromEpoch}–${r.toEpoch}, ${r.gaps.length} gaps)`;

async function main() {
  console.log(`Hush V4 Proof of Alpha e2e on ${NETWORK} · SignalCo ${SIGNALCO} · AlphaKing ${ALPHAKING} · HushAlpha ${hushAlpha}\n`);
  const committer = wallet("COMMITTER").address;
  const veil = wallet("VEIL");
  const subjects: Record<string, Address> = {};

  await check("both providers publish a Proof of Alpha and commit chain heads via COMMITTER", async () => {
    const out: string[] = [];
    for (const base of [SIGNALCO, ALPHAKING]) {
      const page = await pageOf(base);
      assert(page.proofOfAlpha, `${base} publishes no proofOfAlpha`);
      const subject = page.proofOfAlpha.subject;
      subjects[base] = subject;
      const authorised = (await publicClient.readContract({ address: hushAlpha, abi: hushAlphaAbi, functionName: "committerOf", args: [subject] })) as Address;
      assert(authorised.toLowerCase() === committer.toLowerCase(), `${page.name}: committer is ${authorised}, not COMMITTER`);
      const latest = await waitFor(
        async () => {
          const e = (await publicClient.readContract({ address: hushAlpha, abi: hushAlphaAbi, functionName: "latestEpoch", args: [subject] })) as bigint;
          return e > 0n ? e : undefined;
        },
        `${page.name}'s first commit`,
        5 * 60_000,
      );
      out.push(`${page.name} ${subject.slice(0, 8)}… head @ epoch ${latest}`);
    }
    return out.join(" · ");
  });

  // Bought early: by the end of the run the epoch it was issued in is stale and inside SignalCo's proof.
  let bought: { record: SignalRecordJson; signature: Hex; epoch: bigint } | undefined;
  await check("Veil buys a SignalCo call with hush-credit; it is signed by the provider", async () => {
    const pay = createHushFetch({
      mode: "hush-credit",
      wallet: veil.account,
      eercClient: await veil.eerc(contracts).init(),
      publicClient: publicClient as never,
      privacy: { topUpChunks: [5_000_000n], jitterMs: [0, 0] },
    });
    const res = await pay.fetch(`${SIGNALCO}/api/signal?ticker=NVDA`);
    assert(res.ok, `HTTP ${res.status}`);
    const s = (await res.json()) as { direction: string; confidence: number; record: SignalRecordJson; signature: Hex; epoch: string };
    assert(s.record && s.signature, "response carries no signed record");
    assert(s.record.provider.toLowerCase() === subjects[SIGNALCO]?.toLowerCase(), "record is not SignalCo's");
    const ok = await signalTyped.isValid(alphaDomain(contracts.chainId, hushAlpha), signalFromJson(s.record), s.signature);
    assert(ok, "signature does not verify");
    bought = { record: s.record, signature: s.signature, epoch: BigInt(s.epoch) };
    pay.credit?.stop();
    return `${s.direction} (${s.confidence}) issued ${s.record.issuedAt}, epoch ${s.epoch} — kept as evidence`;
  });

  let signalCoProof: AlphaProof | undefined;
  let signalCoReport: ProofReport | undefined;
  await check(`SignalCo's proof verifies with ≥ ${MIN_CALLS} resolved calls`, async () => {
    signalCoReport = await waitFor(async () => {
      const p = await proofOf(SIGNALCO);
      if (p.error) return undefined;
      const r = await verifyProof(p, verifyOpts);
      if (!r.valid) throw new Error(`proof fails at epoch ${r.failedEpoch}: ${r.reason}`);
      if (r.calls < MIN_CALLS) return undefined;
      signalCoProof = p;
      return r;
    }, `${MIN_CALLS} resolved SignalCo calls`);
    return summary(signalCoReport);
  });

  await check("SignalCo's claimed record is what verification computes", async () => {
    for (let attempt = 0; ; attempt++) {
      const p = await proofOf(SIGNALCO);
      const claims = (await pageOf(SIGNALCO)).proofOfAlpha!.claims;
      const r = await verifyProof(p, verifyOpts);
      // The claims window moves at each epoch boundary; retry if the two reads straddled one.
      if (claims.since !== Number(p.fromEpoch) * p.epochLen && attempt < 3) continue;
      assert(r.valid, `proof fails: ${r.reason}`);
      assert(claims.calls === r.calls && claims.winRate === r.winRate, `claims ${pct(claims.winRate)}/${claims.calls} ≠ verified ${pct(r.winRate)}/${r.calls}`);
      return `claims ${pct(claims.winRate)} over ${claims.calls} = verified`;
    }
  });

  await check("AlphaKing's proof fails at the epoch where it dropped a losing call", async () => {
    const { claims, report } = await waitFor(async () => {
      const p = await proofOf(ALPHAKING);
      if (p.error) return undefined;
      const r = await verifyProof(p, verifyOpts);
      return r.valid ? undefined : { claims: (await pageOf(ALPHAKING)).proofOfAlpha!.claims, report: r };
    }, "AlphaKing to hide a resolved loser");
    assert(/diverges/.test(report.reason ?? ""), `unexpected failure: ${report.reason}`);
    return `claims ${pct(claims.winRate)} over ${claims.calls} calls · proof fails at epoch ${report.failedEpoch}: ${report.reason}`;
  });

  await check("tampered SignalCo proofs fail: an edited call, a dropped call", async () => {
    assert(signalCoProof, "no SignalCo proof");
    const withLeaves = signalCoProof.epochs.find((e) => e.leaves.length > 0);
    assert(withLeaves, "proof has no records");
    const edited = structuredClone(signalCoProof);
    const leaf = edited.epochs.find((e) => e.epoch === withLeaves.epoch)!.leaves[0]!;
    const rec = leaf.record as SignalRecordJson;
    rec.direction = rec.direction === 1 ? 2 : 1; // flip UP ↔ DOWN after the fact
    const r1 = await verifyProof(edited, verifyOpts);
    assert(!r1.valid && r1.failedEpoch === withLeaves.epoch && /signature/.test(r1.reason ?? ""), `edit not caught: ${JSON.stringify(r1.reason)}`);
    const dropped = structuredClone(signalCoProof);
    dropped.epochs.find((e) => e.epoch === withLeaves.epoch)!.leaves.shift();
    const r2 = await verifyProof(dropped, verifyOpts);
    assert(!r2.valid && r2.failedEpoch === withLeaves.epoch && /diverges/.test(r2.reason ?? ""), `drop not caught: ${JSON.stringify(r2.reason)}`);
    return `edit → epoch ${r1.failedEpoch} (${r1.reason}) · drop → epoch ${r2.failedEpoch} (diverges)`;
  });

  await check("proofs reveal only resolved calls; an older window verifies on its own", async () => {
    const p = await proofOf(SIGNALCO, "?to=99999999999");
    assert(!p.error, p.error ?? "");
    const now = Math.floor(Date.now() / 1000);
    const live = p.epochs.flatMap((e) => e.leaves).filter((l) => Number((l.record as SignalRecordJson).issuedAt) + Number((l.record as SignalRecordJson).horizonSec) > now);
    assert(live.length === 0, `${live.length} unresolved calls revealed`);
    const to = BigInt(p.toEpoch) - 2n;
    assert(to >= BigInt(p.fromEpoch), "window too short to cut");
    const older = await proofOf(SIGNALCO, `?from=${p.fromEpoch}&to=${to}`);
    const r = await verifyProof(older, verifyOpts);
    assert(r.valid, `older window fails: ${r.reason}`);
    return `to capped at epoch ${p.toEpoch} (no live calls) · epochs ${older.fromEpoch}–${older.toEpoch} verify alone: ${r.records} records`;
  });

  await check("the call Veil paid for is in SignalCo's proof", async () => {
    assert(bought, "nothing bought");
    const b = bought;
    const p = await waitFor(async () => {
      const proof = await proofOf(SIGNALCO, `?from=${b.epoch}&to=${b.epoch}`);
      return proof.error || BigInt(proof.toEpoch) < b.epoch ? undefined : proof;
    }, `epoch ${b.epoch} to resolve`);
    const found = p.epochs.flatMap((e) => e.leaves).some((l) => l.signature.toLowerCase() === b.signature.toLowerCase());
    assert(found, `the bought call (sig ${b.signature.slice(0, 12)}…) is missing — portable evidence for flagProvider`);
    const r = await verifyProof(p, verifyOpts);
    assert(r.valid, `proof of epoch ${b.epoch} fails: ${r.reason}`);
    const g = r.graded.find((x) => x.issuedAt === Number(b.record.issuedAt) && x.direction !== "FLAT");
    return `found in epoch ${b.epoch}${g ? ` · graded ${g.outcome} (${g.returnBps} bps)` : " (FLAT call)"}`;
  });

  await check("the SDK's provider choice (Veil's) picks SignalCo and rejects AlphaKing", async () => {
    // minWinRate 0: this checks the proof, not whether a synthetic strategy happened to beat 50% in a few minutes.
    const { chosen, checks } = await chooseProvider([SIGNALCO, ALPHAKING], { ...verifyOpts, policy: { minWinRate: 0, minCalls: MIN_CALLS } });
    const king = checks.find((c) => c.url === ALPHAKING)!;
    assert(chosen?.url === SIGNALCO, `chose ${chosen?.url ?? "nobody"}: ${checks.map((c) => `${c.name}: ${c.why}`).join(" · ")}`);
    assert(!king.passes, "AlphaKing passed");
    return `${chosen.name}: ${chosen.why} · AlphaKing (claims ${pct(king.claims?.winRate ?? null)}): ${king.why.slice(0, 60)}…`;
  });

  console.log();
  console.table(results);
  const failed = results.filter((r) => r.result === "FAIL").length;
  console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
