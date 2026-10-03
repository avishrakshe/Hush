/**
 * The v2 strategy (AGENT_STRATEGY=trader, default when the deployment has the desk contracts):
 *   buy a direction call for the ticker → decide → trade a lot at the Hush Desk.
 * Atlas and Veil run this exact loop; only the venue differs (public `exact` vs private hush-rfq).
 *
 * env: AGENT_TICKER (NVDA) · AGENT_LOT_SHARES (0.05) · AGENT_MAX_POSITION_SHARES (0.50) · AGENT_MAX_TRADE_USD (25)
 *      AGENT_DAILY_TRADE_CAP_USD (200) · AGENT_BRAIN=claude|rules · RULES_MAX_AGE_SECONDS · RULES_MIN_CONFIDENCE
 *      AGENT_SIGNAL_PROVIDERS (SignalCo,AlphaKing URLs) · AGENT_PROVIDER_CHOICE=verify|claims · AGENT_MIN_WIN_RATE (0.4)
 *      AGENT_MIN_CALLS (10) · AGENT_PROVIDER_RECHECK_SECONDS (600)
 *
 * Choosing a signal provider (D10): Veil verifies each provider's Proof of Alpha against HushAlpha and the oracle before
 * paying for a call (`verify`, the private default); Atlas goes by the win rate a provider advertises (`claims`).
 */
import { URLS, publicClient, txLink } from "@hush/config";
import {
  type AlphaClaims,
  type SignalRecordJson,
  alphaDomain,
  chooseProvider,
  formatPrice,
  formatShares,
  isStockTicker,
  latestRound,
  parseShares,
  signalFromJson,
  signalTyped,
} from "@hush/x402";
import { HushDeskClient, HushPublicDesk, spentToday } from "@hush/x402/client";
import { type Hex, formatUnits, isAddressEqual, parseUnits } from "viem";
import type { AgentContext } from "./context.js";
import { type SignalPurchase, type TradeDecision, type TradeOutcome, type TradeState, makeTraderBrain } from "./traderBrain.js";
import { PrivateVenue, PublicVenue, type Venue } from "./venues.js";

const usd = (v: string) => parseUnits(v, 6);
const fmtUsd = (atomic: bigint) => formatUnits(atomic, 6);

export async function runTrader(ctx: AgentContext) {
  const { profile, contracts, me, telemetry, hush, store, policy, log } = ctx;
  const ticker = (process.env.AGENT_TICKER || "NVDA").toUpperCase();
  if (!isStockTicker(ticker) || !contracts.stocks?.[ticker] || !contracts.stockOracle) throw new Error(`no ${ticker} stock in this deployment`);
  const providers = (process.env.AGENT_SIGNAL_PROVIDERS || `${URLS.provider},${URLS.alphaking}`)
    .split(",")
    .map((u) => u.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const chooseBy = process.env.AGENT_PROVIDER_CHOICE || (profile.mode === "public" ? "claims" : "verify");
  if (chooseBy !== "verify" && chooseBy !== "claims") throw new Error("AGENT_PROVIDER_CHOICE must be verify or claims");
  const alphaPolicy = { minWinRate: Number(process.env.AGENT_MIN_WIN_RATE || 0.4), minCalls: Number(process.env.AGENT_MIN_CALLS || 10) };
  const recheckMs = Number(process.env.AGENT_PROVIDER_RECHECK_SECONDS || 600) * 1000;
  let signalBase = providers[0]!;
  let checkedAt = 0;
  const signalUrl = () => `${signalBase}/api/signal?ticker=${ticker}`;
  const lot =formatShares(parseShares(process.env.AGENT_LOT_SHARES || "0.05"));
  const maxPosition = parseShares(process.env.AGENT_MAX_POSITION_SHARES || "0.50");
  const maxTrade = usd(process.env.AGENT_MAX_TRADE_USD || "25");
  const dailyTradeCap = usd(process.env.AGENT_DAILY_TRADE_CAP_USD || "200");

  const venue: Venue =
    profile.mode === "public"
      ? new PublicVenue(ticker, new HushPublicDesk({ deskUrl: URLS.desk, pay: hush, walletClient: me.walletClient, publicClient: publicClient as never, contracts }), contracts, me.address)
      : new PrivateVenue(ticker, new HushDeskClient({ deskUrl: URLS.desk, hush, signer: me.account }), ctx.eerc!, contracts, store);

  // ─── state ───
  let lastSignal: (NonNullable<SignalPurchase["signal"]> & { boughtAt: number }) | undefined;
  let tradedOnIssuedAt: number | undefined;
  const trades: { at: string; side: "buy" | "sell"; shares: string; priceUsd: string }[] = [];
  let tradedToday = 0n;
  let tradeDay = new Date().toISOString().slice(0, 10);
  let signalPrice = 20_000n;

  const mark = async () => (await latestRound(publicClient, contracts.stockOracle!, ticker)).price;

  /** The signal's 402 tells us its live price (no payment needed to read it). */
  async function readSignalPrice() {
    try {
      const header = (await fetch(signalUrl())).headers.get("PAYMENT-REQUIRED");
      if (header) signalPrice = BigInt((JSON.parse(Buffer.from(header, "base64").toString()) as { accepts: { amount: string }[] }).accepts[0]!.amount);
    } catch {
      log(`signal provider ${signalBase} not reachable yet`);
    }
  }

  /** Pick the signal provider (cached for AGENT_PROVIDER_RECHECK_SECONDS). */
  async function selectProvider() {
    if (providers.length < 2 || (checkedAt && Date.now() - checkedAt < recheckMs)) return;
    checkedAt = Date.now();
    const before = signalBase;
    let report: Record<string, unknown>[];
    if (chooseBy === "claims") {
      const pages = await Promise.all(
        providers.map(async (url) => {
          try {
            const page = (await (await fetch(`${url}/`)).json()) as { name?: string; proofOfAlpha?: { claims?: AlphaClaims } };
            return { url, name: page.name ?? url, claimed: page.proofOfAlpha?.claims?.winRate ?? null, calls: page.proofOfAlpha?.claims?.calls ?? 0 };
          } catch {
            return { url, name: url, claimed: null, calls: 0 };
          }
        }),
      );
      const best = [...pages].sort((a, b) => (b.claimed ?? -1) - (a.claimed ?? -1))[0];
      if (best && best.claimed !== null) signalBase = best.url;
      report = pages;
    } else {
      const { chosen, checks } = await chooseProvider(providers, { publicClient: publicClient as never, oracle: contracts.stockOracle!, policy: alphaPolicy });
      // Nobody passes yet (too few resolved calls): keep the first listed provider whose proof doesn't fail.
      const fallback = checks.find((c) => !c.report || c.report.valid);
      if (chosen) signalBase = chosen.url.replace(/\/$/, "");
      else if (fallback) signalBase = fallback.url.replace(/\/$/, "");
      report = checks.map((c) => ({
        url: c.url,
        name: c.name,
        claimed: c.claims?.winRate ?? null,
        verified: c.report?.valid ? c.report.winRate : null,
        valid: c.report?.valid ?? null,
        calls: c.report?.calls ?? 0,
        failedEpoch: c.report?.failedEpoch ?? null,
        passes: c.passes,
        why: c.why,
      }));
    }
    await telemetry.publish("provider-check", { by: chooseBy, chosen: signalBase, policy: chooseBy === "verify" ? alphaPolicy : null, providers: report });
    for (const r of report) {
      const pct = (x: unknown) => (typeof x === "number" ? `${Math.round(x * 100)}%` : "–");
      log(`provider ${r.name}: claims ${pct(r.claimed)}${chooseBy === "verify" ? ` · verified ${pct(r.verified)} over ${r.calls} calls — ${r.why}` : ""}`);
    }
    log(`signal provider (${chooseBy}): ${signalBase}`);
    if (signalBase !== before) await readSignalPrice();
  }

  async function buySignal(): Promise<SignalPurchase> {
    const t0 = performance.now();
    try {
      await selectProvider().catch((err: Error) => log(`provider check failed: ${err.message.split("\n")[0]}`));
      const res = await hush.fetch(signalUrl());
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const s = (await res.json()) as NonNullable<SignalPurchase["signal"]> & { provider?: Hex; record?: SignalRecordJson; signature?: Hex };
      // A signed call is evidence: keep only calls that really are the provider's (an omitted one can later be shown).
      if (s.record && s.signature && contracts.hushAlpha) {
        const valid =
          isAddressEqual(s.record.provider, s.provider ?? s.record.provider) &&
          (await signalTyped.isValid(alphaDomain(contracts.chainId, contracts.hushAlpha), signalFromJson(s.record), s.signature));
        if (!valid) return { ok: false, error: "the signal's signature is not the provider's" };
      }
      lastSignal = { ...s, boughtAt: Date.now() };
      const ms = Math.round(performance.now() - t0);
      await telemetry.publish("signal", {
        ticker,
        provider: signalBase,
        direction: s.direction,
        confidence: s.confidence,
        price: s.price,
        issuedAt: s.issuedAt,
        horizonSec: s.horizonSec,
        ms,
        ...(s.record && { record: s.record, signature: s.signature }),
      });
      log(`signal ${ticker} ${s.direction} (${s.confidence}) @ $${s.price} from ${signalBase} in ${ms} ms`);
      return { ok: true, signal: s };
    } catch (err) {
      const error = (err as Error).message.split("\n")[0]!;
      await telemetry.publish("signal:failed", { error });
      return { ok: false, error };
    }
  }

  /** Same limits for both agents, checked before the venue is touched (Veil's SDK TradePolicy re-checks its own). */
  async function guard(side: "buy" | "sell", shares: string): Promise<string | undefined> {
    let size: bigint;
    try {
      size = parseShares(shares);
    } catch (err) {
      return (err as Error).message;
    }
    if (size <= 0n) return "size must be positive";
    const { size: held } = await venue.position();
    if (side === "sell") return size > held ? `holding only ${formatShares(held)}` : undefined;
    if (held + size > maxPosition) return `position would be ${formatShares(held + size)} > max ${formatShares(maxPosition)}`;
    const estimate = (size * (await mark())) / 100n;
    if (estimate > maxTrade) return `notional ~$${fmtUsd(estimate)} > per-trade max $${fmtUsd(maxTrade)}`;
    if (tradedToday + estimate > dailyTradeCap) return `daily trading cap $${fmtUsd(dailyTradeCap)} reached`;
    if ((await venue.cash()) < estimate) return `not enough cash for ~$${fmtUsd(estimate)}`;
    return undefined;
  }

  async function trade(side: "buy" | "sell", shares: string): Promise<TradeOutcome> {
    const refused = await guard(side, shares);
    if (refused) return { ok: false, error: refused };
    try {
      const t = side === "buy" ? await venue.buy(shares) : await venue.sell(shares);
      if (side === "buy") tradedToday += t.notional;
      tradedOnIssuedAt = lastSignal?.issuedAt;
      trades.push({ at: new Date().toISOString(), side, shares: formatShares(t.size), priceUsd: formatPrice(t.price) });
      await telemetry.publish("trade", {
        ticker,
        side,
        shares: formatShares(t.size),
        price: formatPrice(t.price),
        notional: fmtUsd(t.notional),
        footprint: t.footprint,
        reference: t.reference,
        ms: t.ms,
      });
      log(`${side} ${formatShares(t.size)} ${ticker} @ $${formatPrice(t.price)} in ${t.ms} ms · ${t.footprint}${profile.mode === "public" ? `  ${txLink(t.reference)}` : ""}`);
      return { ok: true, side, shares: formatShares(t.size), priceUsd: formatPrice(t.price), notionalUsd: fmtUsd(t.notional), footprint: t.footprint };
    } catch (err) {
      const error = (err as Error).message.split("\n")[0]!.slice(0, 200);
      await telemetry.publish("trade:failed", { ticker, side, shares, error });
      log(`${side} ${shares} ${ticker} failed: ${error}`);
      return { ok: false, error };
    }
  }

  async function currentState(): Promise<TradeState> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== tradeDay) {
      tradeDay = today;
      tradedToday = 0n;
    }
    const [m, pos, cash, spent] = await Promise.all([mark(), venue.position(), venue.cash(), spentToday(store)]);
    const pnl = pos.avgCost === null ? null : ((m - pos.avgCost) * pos.size) / 100n;
    return {
      now: new Date().toISOString(),
      ticker,
      venue: venue.label,
      signalPriceUsd: fmtUsd(signalPrice),
      budget: {
        dataDailyCapUsd: fmtUsd(policy.dailyCap),
        dataSpentTodayUsd: fmtUsd(spent),
        tradeDailyCapUsd: fmtUsd(dailyTradeCap),
        tradedTodayUsd: fmtUsd(tradedToday),
        maxTradeUsd: fmtUsd(maxTrade),
      },
      lastSignal: lastSignal
        ? {
            direction: lastSignal.direction,
            confidence: lastSignal.confidence,
            priceUsd: lastSignal.price,
            ageSeconds: Math.round((Date.now() - lastSignal.boughtAt) / 1000),
            horizonSec: lastSignal.horizonSec,
            momentumBps: lastSignal.momentumBps,
            alreadyTradedOn: tradedOnIssuedAt === lastSignal.issuedAt,
          }
        : null,
      markUsd: formatPrice(m),
      position: {
        shares: formatShares(pos.size),
        maxShares: formatShares(maxPosition),
        avgCostUsd: pos.avgCost === null ? null : formatPrice(pos.avgCost),
        unrealizedPnlUsd: pnl === null ? null : fmtUsd(pnl),
      },
      cashUsd: fmtUsd(cash),
      lotShares: lot,
      recentTrades: trades.slice(-5),
    };
  }

  await selectProvider().catch((err: Error) => log(`provider check failed: ${err.message.split("\n")[0]}`));
  await readSignalPrice();

  const brain = makeTraderBrain(profile.name);
  log(profile.tagline);
  log(`strategy trader · ${ticker} lots of ${lot} (max ${formatShares(maxPosition)}) · brain ${brain.name} · every ${ctx.intervalMs / 1000}s`);
  log(`venue: ${venue.label}`);

  for (let tick = 1; ctx.running() && tick <= ctx.maxTicks; tick++) {
    let decision: TradeDecision;
    try {
      decision = await brain.decide(await currentState(), { buySignal, trade });
    } catch (err) {
      decision = { action: "hold", boughtSignal: false, traded: false, rationale: `brain error: ${(err as Error).message.split("\n")[0]}`, brain: brain.name };
    }
    await telemetry.publish("decision", { tick, ...decision });
    const state = await currentState().catch(() => undefined);
    if (state) await telemetry.setState({ ...state, lastDecision: decision, mode: profile.mode, strategy: "trader" });
    log(
      `tick ${tick}: ${decision.action}${decision.shares ? ` ${decision.shares}` : ""} — ${decision.rationale}` +
        `${decision.boughtSignal ? " [bought signal]" : ""}${decision.usage ? ` [tokens in ${decision.usage.input} out ${decision.usage.output} cached ${decision.usage.cacheRead}]` : ""}`,
    );
    if (tick < ctx.maxTicks) await new Promise((r) => setTimeout(r, ctx.intervalMs));
  }
}
