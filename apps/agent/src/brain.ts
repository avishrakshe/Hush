import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

/** What the agent knows at the start of a tick (all money in USD strings for the model). */
export interface TickState {
  now: string;
  pair: "AVAX/USD";
  pricePerCallUsd: string;
  budget: { dailyCapUsd: string; spentTodayUsd: string; remainingTodayUsd: string };
  lastPurchase: null | {
    ageSeconds: number;
    price: number;
    chainlinkRoundId: string;
    chainlinkUpdatedAt: string;
    feedSignal: { action: string; momentumBps: number; confidence: string };
  };
  recentSignals: { at: string; action: string; confidence: number }[];
  purchasesToday: number;
}

export interface FeedPurchase {
  ok: boolean;
  data?: {
    price: number;
    updatedAt: string;
    source: { roundId: string };
    signal: { action: string; momentumBps: number; confidence: string };
  };
  error?: string;
  paidWith?: string;
  /** What the payment reveals publicly (for the event log). */
  receipt?: Record<string, unknown>;
}

export interface Decision {
  kind: "signal" | "wait";
  purchased: boolean;
  action?: "BUY" | "SELL" | "HOLD";
  confidence?: number;
  rationale: string;
  brain: string;
  usage?: { input: number; output: number; cacheRead: number };
}

export interface Brain {
  readonly name: string;
  decide(state: TickState, buyFeed: () => Promise<FeedPurchase>): Promise<Decision>;
}

const SYSTEM = (agentName: string) => `You are ${agentName}, an autonomous market-data agent that publishes one AVAX/USD trading signal per turn.

Each turn you receive your current state as JSON. You have three tools:
- buy_price_feed: buys one reading of the paid API (Chainlink AVAX/USD on Avalanche Fuji plus a momentum indicator). It costs pricePerCallUsd, paid from your daily budget.
- publish_signal: publishes your signal (BUY, SELL or HOLD) with a confidence between 0 and 1 and a one-sentence rationale.
- wait: skips publishing this turn, with a short reason.

How to decide:
- Data is worth buying when you have none yet or when the Chainlink round may have moved on (Chainlink publishes a new round on a price deviation or a heartbeat, so a reading older than a few minutes may be stale). Buying again when your last reading is only seconds old wastes budget.
- Never buy when remainingTodayUsd is below pricePerCallUsd.
- You may call buy_price_feed at most once per turn.
- End every turn with exactly one call to publish_signal or wait. Base the signal on the latest data you have; say so in the rationale when that data is stale.
This is a demo on testnet data — signals are illustrative, not financial advice.`;

/** Claude decides whether fresh data is worth its price, then publishes a signal. One short tool-runner loop per tick. */
export class ClaudeBrain implements Brain {
  readonly name: string;
  private readonly client = new Anthropic();

  constructor(
    private readonly agentName: string,
    private readonly model = process.env.AGENT_MODEL || "claude-sonnet-5",
    // Routine buy/wait choice — low effort keeps each tick cheap and fast; raise via AGENT_EFFORT.
    private readonly effort = (process.env.AGENT_EFFORT || "low") as "low" | "medium" | "high",
  ) {
    this.name = `claude:${this.model}`;
  }

  async decide(state: TickState, buyFeed: () => Promise<FeedPurchase>): Promise<Decision> {
    let purchased = false;
    let decision: Omit<Decision, "brain" | "purchased" | "usage"> | undefined;

    const tools = [
      betaZodTool({
        name: "buy_price_feed",
        description: `Buy one AVAX/USD reading from the paid API for ${state.pricePerCallUsd} USD. At most once per turn.`,
        inputSchema: z.object({}),
        run: async () => {
          if (purchased) return "Already purchased this turn — use the data you have.";
          purchased = true;
          const r = await buyFeed();
          return JSON.stringify(r.ok ? r.data : { error: r.error });
        },
      }),
      betaZodTool({
        name: "publish_signal",
        description: "Publish this turn's trading signal. Ends the turn.",
        inputSchema: z.object({
          action: z.enum(["BUY", "SELL", "HOLD"]),
          confidence: z.number().min(0).max(1),
          rationale: z.string().max(280).describe("One sentence"),
        }),
        run: async (input) => {
          decision ??= { kind: "signal", ...input };
          return "Published.";
        },
      }),
      betaZodTool({
        name: "wait",
        description: "Skip publishing this turn. Ends the turn.",
        inputSchema: z.object({ reason: z.string().max(200) }),
        run: async ({ reason }) => {
          decision ??= { kind: "wait", rationale: reason };
          return "Waiting.";
        },
      }),
    ];

    const final = await this.client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: 16000,
      max_iterations: 4,
      output_config: { effort: this.effort },
      // The system prompt is identical every tick; cache it (volatile state goes in the user turn).
      system: [{ type: "text", text: SYSTEM(this.agentName), cache_control: { type: "ephemeral" } }],
      tools,
      messages: [{ role: "user", content: `Current state:\n${JSON.stringify(state, null, 2)}` }],
    });

    const usage = {
      input: final.usage.input_tokens,
      output: final.usage.output_tokens,
      cacheRead: final.usage.cache_read_input_tokens ?? 0,
    };
    if (final.stop_reason === "refusal") {
      return { kind: "wait", purchased, rationale: "model declined this turn", brain: this.name, usage };
    }
    if (!decision) {
      return { kind: "wait", purchased, rationale: "turn ended without a decision", brain: this.name, usage };
    }
    return { ...decision, purchased, brain: this.name, usage };
  }
}

/**
 * Deterministic fallback (no Anthropic credentials, or AGENT_BRAIN=rules): buy when data is missing or older than
 * `maxAgeSeconds`, then follow the feed's momentum indicator. Keeps the payment pipeline demoable offline.
 */
export class RulesBrain implements Brain {
  readonly name = "rules";
  constructor(private readonly maxAgeSeconds = Number(process.env.RULES_MAX_AGE_SECONDS || 60)) {}

  async decide(state: TickState, buyFeed: () => Promise<FeedPurchase>): Promise<Decision> {
    const canAfford = Number(state.budget.remainingTodayUsd) >= Number(state.pricePerCallUsd);
    const stale = !state.lastPurchase || state.lastPurchase.ageSeconds > this.maxAgeSeconds;
    let signal = state.lastPurchase?.feedSignal;
    let purchased = false;
    if (stale && canAfford) {
      const r = await buyFeed();
      purchased = true;
      if (r.ok && r.data) signal = r.data.signal;
      else return { kind: "wait", purchased, rationale: `purchase failed: ${r.error}`, brain: this.name };
    }
    if (!signal) return { kind: "wait", purchased, rationale: "no data and no budget", brain: this.name };
    return {
      kind: "signal",
      purchased,
      action: signal.action as Decision["action"],
      confidence: Number(signal.confidence),
      rationale: `${purchased ? "fresh" : "cached"} momentum ${signal.momentumBps} bps`,
      brain: this.name,
    };
  }
}

export function makeBrain(agentName: string): Brain {
  const choice = process.env.AGENT_BRAIN;
  if (choice === "rules") return new RulesBrain();
  if (choice === "claude" || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return new ClaudeBrain(agentName);
  console.warn("No Anthropic credentials (ANTHROPIC_API_KEY) — using the deterministic rules brain. Set AGENT_BRAIN=claude to force Claude.");
  return new RulesBrain();
}
