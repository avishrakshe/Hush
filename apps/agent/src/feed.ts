/**
 * The v1 strategy (AGENT_STRATEGY=feed): buy AVAX/USD data from the provider and publish a signal each tick.
 * Unchanged from P4 apart from moving out of index.ts.
 */
import { URLS, txLink } from "@hush/config";
import { spentToday } from "@hush/x402/client";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { formatUnits } from "viem";
import { type Decision, type FeedPurchase, type TickState, makeBrain } from "./brain.js";
import type { AgentContext } from "./context.js";

const fmtUsd = (atomic: bigint) => formatUnits(atomic, 6);

export async function runFeed(ctx: AgentContext) {
  const { profile, telemetry, hush, store, policy, log } = ctx;
  const FEED_URL = process.env.FEED_URL || `${URLS.provider}/api/feed`;

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
  log(`strategy feed · brain ${brain.name} · every ${ctx.intervalMs / 1000}s · budget $${fmtUsd(policy.dailyCap)}/day · telemetry http://localhost:${profile.port}/events`);

  for (let tick = 1; ctx.running() && tick <= ctx.maxTicks; tick++) {
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
    if (tick < ctx.maxTicks) await new Promise((r) => setTimeout(r, ctx.intervalMs));
  }
}
