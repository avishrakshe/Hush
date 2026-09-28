/**
 * Hush demo agent — one codebase, two instances with the same goal (buy AVAX/USD data, publish a signal):
 *
 *   pnpm --filter @hush/agent atlas   # pays with public x402 `exact`
 *   pnpm --filter @hush/agent veil    # pays with hush-credit; telemetry sealed to owner + auditor
 *
 * Options: --local (hardhat node) · --ticks N (stop after N ticks) · env AGENT_INTERVAL_SECONDS, AGENT_DAILY_CAP_USD,
 * AGENT_BRAIN=claude|rules, AGENT_MODEL, AGENT_EFFORT, FEED_URL.
 */
import { NETWORK, URLS, loadContracts, publicClient, txLink, wallet } from "@hush/config";
import { encryptedErcAbi, formatUsdc, hushRegistryAbi } from "@hush/x402";
import { createHushFetch, spentToday } from "@hush/x402/client";
import { JsonFileHushStore } from "@hush/x402/node";
import { decodePaymentResponseHeader } from "@x402/fetch";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, formatUnits, parseUnits } from "viem";
import { type Decision, type FeedPurchase, type TickState, makeBrain } from "./brain.js";
import { profileFromArgs } from "./profiles.js";
import { Telemetry } from "./telemetry.js";

const profile = profileFromArgs();
const argTicks = process.argv.indexOf("--ticks");
const MAX_TICKS = argTicks >= 0 ? Number(process.argv[argTicks + 1]) : Number.POSITIVE_INFINITY;
const INTERVAL_MS = Number(process.env.AGENT_INTERVAL_SECONDS || 30) * 1000;
const FEED_URL = process.env.FEED_URL || `${URLS.provider}/api/feed`;
const usd = (v: string) => parseUnits(v, 6);
const fmtUsd = (atomic: bigint) => formatUnits(atomic, 6);

const contracts = loadContracts();
const me = wallet(profile.role);
const eerc = profile.mode === "public" ? undefined : await me.eerc(contracts).init();
const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} [${profile.name}] ${msg}`);

// ─── telemetry: Veil seals every event to its owner's and the eERC auditor's keys ───
let sealer: { account: NonNullable<typeof eerc>; recipients: bigint[][] } | undefined;
if (eerc) {
  const { owner } = await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getAgent", args: [me.address] });
  const auditor = (await publicClient.readContract({ address: contracts.encryptedErc, abi: encryptedErcAbi, functionName: "auditor" })) as Address;
  const recipients = [await eerc.publicKeyOf(owner), await eerc.publicKeyOf(auditor)].filter(([x, y]) => x !== 0n || y !== 0n);
  if (recipients.length === 0) throw new Error("Veil's owner has no eERC key — run bootstrap first");
  sealer = { account: eerc, recipients };
  log(`telemetry sealed to owner ${owner} + auditor ${auditor}`);
}
const telemetry = new Telemetry(profile.id, sealer, { mode: profile.mode, address: me.address, network: NETWORK });
telemetry.listen(profile.port);

// ─── payments ───
const providers = (await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getProviders" })) as Address[];
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const store = new JsonFileHushStore(path.join(APP_DIR, ".data", `${profile.id}-${NETWORK}.json`));
const policy = {
  dailyCap: usd(process.env.AGENT_DAILY_CAP_USD || "1.00"),
  maxPerCall: usd(process.env.AGENT_MAX_PER_CALL_USD || "0.05"),
  allowedProviders: providers, // only pay providers listed in HushRegistry
};
const hush = createHushFetch({
  mode: profile.mode,
  wallet: me.account,
  eercClient: eerc,
  publicClient: publicClient as never,
  policy,
  privacy: { topUpChunks: [5_000_000n], jitterMs: [10_000, 45_000] },
  store,
  onEvent: (e) => {
    void telemetry.publish(`sdk:${e.type}`, e as unknown as Record<string, unknown>);
    if (e.type === "topup:credited") log(`private top-up credited ${formatUsdc(e.amount)} (receipt signed by provider)  ${txLink(e.txHash)}`);
  },
});

// ─── agent state ───
let lastPurchase: (NonNullable<TickState["lastPurchase"]> & { at: number }) | undefined;
const signals: { at: string; action: string; confidence: number }[] = [];
let purchasesToday = 0;
let pricePerCall = 20_000n;

async function buyFeed(): Promise<FeedPurchase> {
  const t0 = performance.now();
  try {
    const res = await hush.fetch(FEED_URL);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as NonNullable<FeedPurchase["data"]>;
    const header = res.headers.get("PAYMENT-RESPONSE");
    const settle = header ? decodePaymentResponseHeader(header) : undefined;
    const ms = Math.round(performance.now() - t0);
    purchasesToday++;
    lastPurchase = {
      at: Date.now(),
      ageSeconds: 0,
      price: data.price,
      chainlinkRoundId: data.source.roundId,
      chainlinkUpdatedAt: data.updatedAt,
      feedSignal: data.signal,
    };
    const receipt = { scheme: profile.mode === "public" ? "exact" : profile.mode, reference: settle?.transaction, amount: settle?.amount, ms };
    await telemetry.publish("purchase", { price: data.price, round: data.source.roundId, ...receipt });
    log(`bought AVAX/USD ${data.price} in ${ms} ms via ${receipt.scheme}${profile.mode === "public" && settle?.transaction ? `  ${txLink(settle.transaction)}` : ""}`);
    return { ok: true, data, paidWith: receipt.scheme, receipt };
  } catch (err) {
    const error = (err as Error).message.split("\n")[0]!;
    await telemetry.publish("purchase:failed", { error });
    log(`purchase failed: ${error}`);
    return { ok: false, error };
  }
}

async function currentState(): Promise<TickState> {
  const spent = await spentToday(store);
  return {
    now: new Date().toISOString(),
    pair: "AVAX/USD",
    pricePerCallUsd: fmtUsd(pricePerCall),
    budget: { dailyCapUsd: fmtUsd(policy.dailyCap), spentTodayUsd: fmtUsd(spent), remainingTodayUsd: fmtUsd(policy.dailyCap - spent) },
    lastPurchase: lastPurchase ? { ...lastPurchase, ageSeconds: Math.round((Date.now() - lastPurchase.at) / 1000) } : null,
    recentSignals: signals.slice(-5),
    purchasesToday,
  };
}

// The 402 challenge tells us the live price per call (no payment needed to read it).
try {
  const challenge = await fetch(FEED_URL);
  const header = challenge.headers.get("PAYMENT-REQUIRED");
  if (header) pricePerCall = BigInt((JSON.parse(Buffer.from(header, "base64").toString()) as { accepts: { amount: string }[] }).accepts[0]!.amount);
} catch {
  log(`provider ${FEED_URL} not reachable yet`);
}

const brain = makeBrain(profile.name);
log(`${profile.tagline}`);
log(`brain ${brain.name} · every ${INTERVAL_MS / 1000}s · budget $${fmtUsd(policy.dailyCap)}/day · telemetry http://localhost:${profile.port}/events`);

let running = true;
process.on("SIGINT", () => {
  running = false;
});

for (let tick = 1; running && tick <= MAX_TICKS; tick++) {
  const state = await currentState();
  let decision: Decision;
  try {
    decision = await brain.decide(state, buyFeed);
  } catch (err) {
    decision = { kind: "wait", purchased: false, rationale: `brain error: ${(err as Error).message.split("\n")[0]}`, brain: brain.name };
  }
  if (decision.kind === "signal" && decision.action) {
    signals.push({ at: new Date().toISOString(), action: decision.action, confidence: decision.confidence ?? 0 });
  }
  await telemetry.publish("decision", { tick, ...decision });
  await telemetry.setState({ ...(await currentState()), lastDecision: decision, mode: profile.mode });
  log(
    `tick ${tick}: ${decision.kind === "signal" ? `${decision.action} (${decision.confidence})` : "wait"} — ${decision.rationale}` +
      `${decision.purchased ? " [bought data]" : ""}${decision.usage ? ` [tokens in ${decision.usage.input} out ${decision.usage.output} cached ${decision.usage.cacheRead}]` : ""}`,
  );
  if (tick < MAX_TICKS) await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

hush.credit?.stop();
log("stopped");
process.exit(0);
