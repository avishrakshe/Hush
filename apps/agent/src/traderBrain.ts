import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

/** What the trading agent knows at the start of a tick (money in USD strings, sizes in shares, for the model). */
export interface TradeState {
  now: string;
  ticker: string;
  /** How this agent's trades settle — the only difference between Atlas and Veil. */
  venue: string;
  signalPriceUsd: string;
  budget: { dataDailyCapUsd: string; dataSpentTodayUsd: string; tradeDailyCapUsd: string; tradedTodayUsd: string; maxTradeUsd: string };
  lastSignal: null | {
    direction: "UP" | "DOWN" | "FLAT";
    confidence: number;
    priceUsd: number;
    ageSeconds: number;
    horizonSec: number;
    momentumBps: number;
    alreadyTradedOn: boolean;
  };
  markUsd: string;
  position: { shares: string; maxShares: string; avgCostUsd: string | null; unrealizedPnlUsd: string | null };
  cashUsd: string;
  lotShares: string;
  recentTrades: { at: string; side: "buy" | "sell"; shares: string; priceUsd: string }[];
}

export interface SignalPurchase {
  ok: boolean;
  signal?: { direction: "UP" | "DOWN" | "FLAT"; confidence: number; price: number; issuedAt: number; horizonSec: number; momentumBps: number };
  error?: string;
}

export interface TradeOutcome {
  ok: boolean;
  side?: "buy" | "sell";
  shares?: string;
  priceUsd?: string;
  notionalUsd?: string;
  /** What the trade left on-chain (Atlas: two public transfers; Veil: nothing). */
  footprint?: string;
  error?: string;
}

export interface TradeDecision {
  action: "buy" | "sell" | "hold";
  shares?: string;
  boughtSignal: boolean;
  traded: boolean;
  rationale: string;
  brain: string;
  usage?: { input: number; output: number; cacheRead: number };
}

export interface TraderTools {
  buySignal(): Promise<SignalPurchase>;
  /** Guards (position, per-trade and daily caps) run inside; a refusal comes back as `ok: false` with the reason. */
  trade(side: "buy" | "sell", shares: string): Promise<TradeOutcome>;
}

export interface TraderBrain {
  readonly name: string;
  decide(state: TradeState, tools: TraderTools): Promise<TradeDecision>;
}

const SYSTEM = (agentName: string) => `You are ${agentName}, an autonomous trading agent on Avalanche Fuji testnet. You trade one mock stock (a testnet token, not a real share) through a market maker called the Hush Desk.

Each turn you receive your current state as JSON. You have three tools:
- buy_signal: buys one direction call (UP, DOWN or FLAT, with a confidence) for your ticker from a paid signal provider. It costs signalPriceUsd from your data budget. At most once per turn.
- trade: buys or sells your ticker at the desk's live quote. Sizes are in shares with at most two decimals. At most one trade per turn.
- hold: ends the turn without trading, with a short reason.

How to decide:
- A signal is worth buying when you have none, when lastSignal is older than a minute or two, or when you already traded on it (alreadyTradedOn). Don't buy a new one when yours is only seconds old and unused.
- Trade in lots of lotShares. Buy on a confident UP call while position.shares is below maxShares; sell (up to one lot, never more than you hold) on a DOWN call. FLAT or low-confidence calls (below ~0.55) mean hold.
- Never trade twice on the same signal. If a trade is refused, accept the reason and hold.
- End every turn with exactly one trade or one hold.
This is a testnet demo with synthetic prices — decisions are illustrative, not investment advice.`;

/** Claude decides whether a fresh signal is worth its price and whether to trade on it. One short tool-runner loop per tick. */
export class ClaudeTrader implements TraderBrain {
  readonly name: string;
  private readonly client = new Anthropic();

  constructor(
    private readonly agentName: string,
    private readonly model = process.env.AGENT_MODEL || "claude-sonnet-5",
    // Routine buy/trade/hold choice — low effort keeps each tick cheap and fast; raise via AGENT_EFFORT.
    private readonly effort = (process.env.AGENT_EFFORT || "low") as "low" | "medium" | "high",
  ) {
    this.name = `claude:${this.model}`;
  }

  async decide(state: TradeState, tools: TraderTools): Promise<TradeDecision> {
    let boughtSignal = false;
    let traded = false;
    let decision: Pick<TradeDecision, "action" | "shares" | "rationale"> | undefined;

    const runnerTools = [
      betaZodTool({
        name: "buy_signal",
        description: `Buy one ${state.ticker} direction call for ${state.signalPriceUsd} USD. At most once per turn.`,
        inputSchema: z.object({}),
        run: async () => {
          if (boughtSignal) return "Already bought a signal this turn — use it.";
          boughtSignal = true;
          const r = await tools.buySignal();
          return JSON.stringify(r.ok ? r.signal : { error: r.error });
        },
      }),
      betaZodTool({
        name: "trade",
        description: "Buy or sell your ticker at the desk's live quote. Ends the turn.",
        inputSchema: z.object({
          side: z.enum(["buy", "sell"]),
          shares: z.string().regex(/^\d+(\.\d{1,2})?$/).describe("Shares, e.g. \"0.05\""),
          rationale: z.string().max(280).describe("One sentence"),
        }),
        run: async ({ side, shares, rationale }) => {
          if (decision) return "Turn already decided.";
          const r = await tools.trade(side, shares);
          traded = r.ok;
          decision = r.ok ? { action: side, shares, rationale } : { action: "hold", rationale: `trade refused: ${r.error}` };
          return JSON.stringify(r);
        },
      }),
      betaZodTool({
        name: "hold",
        description: "End the turn without trading. Ends the turn.",
        inputSchema: z.object({ reason: z.string().max(200) }),
        run: async ({ reason }) => {
          decision ??= { action: "hold", rationale: reason };
          return "Holding.";
        },
      }),
    ];

    const final = await this.client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: 16000,
      max_iterations: 5,
      output_config: { effort: this.effort },
      // The system prompt is identical every tick; cache it (volatile state goes in the user turn).
      system: [{ type: "text", text: SYSTEM(this.agentName), cache_control: { type: "ephemeral" } }],
      tools: runnerTools,
      messages: [{ role: "user", content: `Current state:\n${JSON.stringify(state, null, 2)}` }],
    });

    const usage = { input: final.usage.input_tokens, output: final.usage.output_tokens, cacheRead: final.usage.cache_read_input_tokens ?? 0 };
    if (final.stop_reason === "refusal") return { action: "hold", boughtSignal, traded, rationale: "model declined this turn", brain: this.name, usage };
    return { ...(decision ?? { action: "hold", rationale: "turn ended without a decision" }), boughtSignal, traded, brain: this.name, usage };
  }
}

/**
 * Deterministic strategy (AGENT_BRAIN=rules, or no Anthropic credentials): refresh the signal when it is missing, older
 * than RULES_MAX_AGE_SECONDS or already acted on; buy a lot on a confident UP, sell a lot on DOWN, else hold.
 * Atlas and Veil run this same code — only the venue differs.
 */
export class RulesTrader implements TraderBrain {
  readonly name = "rules";
  constructor(
    private readonly maxAgeSeconds = Number(process.env.RULES_MAX_AGE_SECONDS || 60),
    private readonly minConfidence = Number(process.env.RULES_MIN_CONFIDENCE || 0.55),
  ) {}

  async decide(state: TradeState, tools: TraderTools): Promise<TradeDecision> {
    const base = { boughtSignal: false, traded: false, brain: this.name };
    const canAffordData = Number(state.budget.dataDailyCapUsd) - Number(state.budget.dataSpentTodayUsd) >= Number(state.signalPriceUsd);
    let signal = state.lastSignal && { ...state.lastSignal };
    const stale = !signal || signal.ageSeconds > this.maxAgeSeconds || signal.alreadyTradedOn;
    if (stale && canAffordData) {
      const r = await tools.buySignal();
      base.boughtSignal = true;
      if (!r.ok || !r.signal) return { ...base, action: "hold", rationale: `signal purchase failed: ${r.error}` };
      signal = { ...r.signal, priceUsd: r.signal.price, ageSeconds: 0, alreadyTradedOn: false };
    }
    if (!signal) return { ...base, action: "hold", rationale: "no signal and no data budget" };
    if (signal.alreadyTradedOn) return { ...base, action: "hold", rationale: "already traded on the latest signal" };

    const lot = Number(state.lotShares);
    const held = Number(state.position.shares);
    if (signal.direction === "UP" && signal.confidence >= this.minConfidence && held + lot <= Number(state.position.maxShares) + 1e-9) {
      const r = await tools.trade("buy", state.lotShares);
      return { ...base, action: r.ok ? "buy" : "hold", shares: state.lotShares, traded: r.ok, rationale: r.ok ? `UP ${signal.confidence} → buy ${state.lotShares}` : `buy refused: ${r.error}` };
    }
    if (signal.direction === "DOWN" && held > 0) {
      const shares = Math.min(lot, held).toFixed(2);
      const r = await tools.trade("sell", shares);
      return { ...base, action: r.ok ? "sell" : "hold", shares, traded: r.ok, rationale: r.ok ? `DOWN ${signal.confidence} → sell ${shares}` : `sell refused: ${r.error}` };
    }
    return { ...base, action: "hold", rationale: `${signal.direction} (${signal.confidence}) — no trade (position ${state.position.shares})` };
  }
}

export function makeTraderBrain(agentName: string): TraderBrain {
  const choice = process.env.AGENT_BRAIN;
  if (choice === "rules") return new RulesTrader();
  if (choice === "claude" || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return new ClaudeTrader(agentName);
  console.warn("No Anthropic credentials (ANTHROPIC_API_KEY) — using the deterministic rules trader. Set AGENT_BRAIN=claude to force Claude.");
  return new RulesTrader();
}
