/**
 * Hush demo agent — one codebase, two instances with the same goal and the same strategy:
 *
 *   pnpm --filter @hush/agent atlas   # pays and trades publicly (x402 `exact`)
 *   pnpm --filter @hush/agent veil    # pays with hush-credit, trades with hush-rfq; telemetry sealed to owner + auditor
 *
 * Strategies (AGENT_STRATEGY or --strategy): `trader` (v2, default when the desk contracts are deployed) — buy a stock
 * signal, decide, trade at the Hush Desk; `feed` (v1) — buy AVAX/USD data and publish a signal.
 *
 * Options: --local (hardhat node) · --ticks N (stop after N ticks) · env AGENT_INTERVAL_SECONDS, AGENT_DAILY_CAP_USD,
 * AGENT_BRAIN=claude|rules, AGENT_MODEL, AGENT_EFFORT (+ the trader's AGENT_* knobs in trader.ts).
 */
import { NETWORK, loadContracts, publicClient, stateTag, txLink, wallet } from "@hush/config";
import { encryptedErcAbi, formatUsdc, hushRegistryAbi, parseShares } from "@hush/x402";
import { createHushFetch } from "@hush/x402/client";
import { JsonFileHushStore } from "@hush/x402/node";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, parseUnits } from "viem";
import type { AgentContext } from "./context.js";
import { runFeed } from "./feed.js";
import { profileFromArgs } from "./profiles.js";
import { Telemetry } from "./telemetry.js";
import { runTrader } from "./trader.js";

const profile = profileFromArgs();
const argTicks = process.argv.indexOf("--ticks");
const argStrategy = process.argv.indexOf("--strategy");
const contracts = loadContracts();
const STRATEGY =
  (argStrategy >= 0 ? process.argv[argStrategy + 1] : process.env.AGENT_STRATEGY) ?? (contracts.hushAlpha && contracts.stocks ? "trader" : "feed");
if (STRATEGY !== "trader" && STRATEGY !== "feed") throw new Error("strategy must be trader or feed");
const usd = (v: string) => parseUnits(v, 6);

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
const telemetry = new Telemetry(profile.id, sealer, { mode: profile.mode, address: me.address, network: NETWORK, strategy: STRATEGY });
telemetry.listen(profile.port);

// ─── payments ───
const providers = (await publicClient.readContract({ address: contracts.hushRegistry, abi: hushRegistryAbi, functionName: "getProviders" })) as Address[];
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const store = new JsonFileHushStore(path.join(APP_DIR, ".data", `${profile.id}-${NETWORK}${await stateTag()}.json`));
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
  // Trades at the desk (Veil): the SDK re-checks these before signing any voucher.
  tradePolicy: {
    maxNotionalPerTrade: usd(process.env.AGENT_MAX_TRADE_USD || "25"),
    maxPosition: parseShares(process.env.AGENT_MAX_POSITION_SHARES || "0.50"),
    dailyNotionalCap: usd(process.env.AGENT_DAILY_TRADE_CAP_USD || "200"),
  },
  // Every top-up is the same fixed size, so top-ups don't reveal how much the agent means to spend. The trader tops
  // up the desk too, so it uses bigger chunks (one covers ~2 lots).
  privacy: { topUpChunks: [STRATEGY === "trader" ? 20_000_000n : 5_000_000n], jitterMs: [10_000, 45_000] },
  store,
  onEvent: (e) => {
    void telemetry.publish(`sdk:${e.type}`, e as unknown as Record<string, unknown>);
    if (e.type === "topup:credited") log(`private top-up credited ${formatUsdc(e.amount)} (receipt signed by provider)  ${txLink(e.txHash)}`);
  },
});

let running = true;
process.on("SIGINT", () => {
  running = false;
});

const ctx: AgentContext = {
  profile,
  contracts,
  me,
  eerc,
  telemetry,
  store,
  policy,
  hush,
  log,
  maxTicks: argTicks >= 0 ? Number(process.argv[argTicks + 1]) : Number.POSITIVE_INFINITY,
  intervalMs: Number(process.env.AGENT_INTERVAL_SECONDS || 30) * 1000,
  running: () => running,
};
await (STRATEGY === "trader" ? runTrader(ctx) : runFeed(ctx));

hush.credit?.stop();
log("stopped");
process.exit(0);
