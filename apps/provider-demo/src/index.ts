/**
 * Hush demo provider ("SignalCo") — paid APIs an AI trading agent would buy repeatedly.
 *
 *   GET /api/feed                $0.02   AVAX/USD from Chainlink on Fuji + a momentum signal
 *   GET /api/signal?ticker=NVDA  $0.02   mock-stock direction call from MockStockOracle rounds (v2; NVDA, TSLA, SPY)
 *
 * Payable with x402 `exact` (public), `hush-credit` (private, the product) or `hush-direct` (private, reference),
 * all from one middleware line.
 */
import { NETWORK, PORTS, URLS, loadContracts, publicClient, wallet } from "@hush/config";
import { type OracleRound, STOCK_TICKERS, formatPrice, isStockTicker, recentRounds } from "@hush/x402/contracts";
import { hushMiddleware } from "@hush/x402/server";
import express from "express";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { avalancheFuji } from "viem/chains";

const PRICE = process.env.FEED_PRICE || "$0.02";
const SIGNAL_PRICE = process.env.SIGNAL_PRICE || "$0.02";
// Proof of Alpha commits each epoch's chain head only after the epoch closes, so a signal can stay unbound for up to two
// epochs (600 s each on Fuji, 60 s locally). A shorter horizon would let a provider grade its calls before committing.
const SIGNAL_HORIZON_SECONDS = Number(process.env.SIGNAL_HORIZON_SECONDS || (NETWORK === "localhost" ? 120 : 1200));
const contracts = loadContracts();
const provider = wallet("PROVIDER");

// ─── data: Chainlink AVAX/USD on Fuji (read from Fuji even when payments run on a local chain) ───
const CHAINLINK_AVAX_USD_FUJI = "0x5498BB86BC934c8D34FDA08E81D444153d0D06aD"; // verified: description() = "AVAX / USD"
const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
const fuji = createPublicClient({
  chain: avalancheFuji,
  transport: http(process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc"),
});

interface Round {
  roundId: string;
  price: number;
  updatedAt: number;
}
let cache: { at: number; rounds: Round[] } | undefined;

/** Latest round plus up to 11 previous rounds (Chainlink round ids decrement within a phase). */
async function readRounds(): Promise<Round[]> {
  if (cache && Date.now() - cache.at < 15_000) return cache.rounds;
  const decimals = await fuji.readContract({ address: CHAINLINK_AVAX_USD_FUJI, abi: aggregatorAbi, functionName: "decimals" });
  const [roundId, answer, , updatedAt] = await fuji.readContract({ address: CHAINLINK_AVAX_USD_FUJI, abi: aggregatorAbi, functionName: "latestRoundData" });
  const rounds: Round[] = [{ roundId: roundId.toString(), price: Number(formatUnits(answer, decimals)), updatedAt: Number(updatedAt) }];
  // Previous rounds in parallel (ids below the phase start revert or return updatedAt = 0 and are dropped).
  const ids = Array.from({ length: 11 }, (_, i) => roundId - BigInt(i + 1)).filter((id) => (id & 0xffff_ffff_ffff_ffffn) > 0n);
  const history = await Promise.all(
    ids.map((id) =>
      fuji
        .readContract({ address: CHAINLINK_AVAX_USD_FUJI, abi: aggregatorAbi, functionName: "getRoundData", args: [id] })
        .then(([, a, , u]) => (u === 0n ? null : { roundId: id.toString(), price: Number(formatUnits(a, decimals)), updatedAt: Number(u) }))
        .catch(() => null),
    ),
  );
  for (const r of history) {
    if (!r) break;
    rounds.push(r);
  }
  cache = { at: Date.now(), rounds };
  return rounds;
}

const ema = (xs: number[], n: number) => xs.reduce((acc, x, i) => (i === 0 ? x : acc + (2 / (n + 1)) * (x - acc)), xs[0] ?? 0);

/** Synthetic signal: fast vs slow EMA over recent Chainlink rounds. Illustrative only — not financial advice. */
function momentumSignal(rounds: Round[]) {
  const prices = [...rounds].reverse().map((r) => r.price); // oldest → newest
  const fast = ema(prices, 3);
  const slow = ema(prices, 8);
  const momentumBps = slow === 0 ? 0 : Math.round(((fast - slow) / slow) * 10_000);
  const action = momentumBps > 15 ? "BUY" : momentumBps < -15 ? "SELL" : "HOLD";
  return { action, momentumBps, confidence: Math.min(0.95, Math.abs(momentumBps) / 100 + 0.35).toFixed(2), window: prices.length };
}

/**
 * Mock-stock direction call: fast vs slow EMA over the latest oracle rounds (newest first in, oldest → newest here).
 * UP/DOWN are graded later against MockStockOracle.getPriceAt(issuedAt + horizonSec); FLAT makes no call.
 * Synthetic and illustrative — not investment advice.
 */
function stockSignal(rounds: OracleRound[]) {
  const prices = [...rounds].reverse().map((r) => Number(formatPrice(r.price)));
  const fast = ema(prices, 3);
  const slow = ema(prices, 8);
  const momentumBps = slow === 0 ? 0 : Math.round(((fast - slow) / slow) * 10_000);
  const direction = momentumBps > 5 ? "UP" : momentumBps < -5 ? "DOWN" : "FLAT";
  const confidence = Number(Math.min(0.9, 0.5 + Math.abs(momentumBps) / 200).toFixed(2));
  return { direction, confidence, momentumBps, window: prices.length } as const;
}

// ─── http ───
const app = express();

app.get("/", (_req, res) => {
  res.json({
    name: "Hush PriceFeed (demo provider)",
    paid: { "GET /api/feed": PRICE, ...(contracts.stockOracle && { "GET /api/signal?ticker=NVDA|TSLA|SPY": SIGNAL_PRICE }) },
    schemes: ["hush-credit", "exact", "hush-direct"],
    payTo: provider.address,
    facilitator: URLS.facilitator,
    network: NETWORK,
  });
});
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// x402's resource server syncs supported schemes from the facilitator once at startup and doesn't retry,
// so don't mount the middleware until the facilitator answers.
async function waitForFacilitator(url: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${url}/supported`)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`facilitator ${url} not reachable`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
await waitForFacilitator(URLS.facilitator);

// Reject bad input before the paywall, so nobody is asked to pay for a 400.
app.use("/api/signal", (req, res, next) => {
  const ticker = String(req.query.ticker ?? "").toUpperCase();
  if (!contracts.stockOracle) return void res.status(404).json({ error: "this deployment has no mock stocks" });
  if (!isStockTicker(ticker) || !contracts.stocks?.[ticker]) {
    return void res.status(400).json({ error: `ticker must be one of ${STOCK_TICKERS.join(", ")}` });
  }
  next();
});

// The one line that makes the routes payable with all three schemes.
app.use(
  hushMiddleware({
    payTo: provider.address,
    contracts,
    facilitatorUrl: URLS.facilitator,
    routes: {
      "GET /api/feed": { price: PRICE, description: "AVAX/USD (Chainlink on Fuji) + momentum signal" },
      ...(contracts.stockOracle && {
        "GET /api/signal": { price: SIGNAL_PRICE, description: "Mock-stock direction call (NVDA, TSLA, SPY) from on-chain oracle rounds" },
      }),
    },
    minTopUp: 1_000_000n,
  }),
);

app.get("/api/signal", async (req, res) => {
  const ticker = String(req.query.ticker).toUpperCase();
  try {
    const rounds = await recentRounds(publicClient, contracts.stockOracle!, ticker, 12);
    const latest = rounds[0];
    if (!latest) return void res.status(503).json({ error: `no oracle rounds for ${ticker} yet` });
    const signal = stockSignal(rounds);
    // Never stamp a signal before the round it quotes: graders look the price up with getPriceAt(issuedAt).
    const issuedAt = Math.max(Math.floor(Date.now() / 1000), Number(latest.timestamp));
    res.json({
      provider: provider.address,
      ticker,
      direction: signal.direction,
      confidence: signal.confidence,
      price: Number(formatPrice(latest.price)),
      issuedAt,
      horizonSec: SIGNAL_HORIZON_SECONDS,
      momentumBps: signal.momentumBps,
      source: {
        oracle: contracts.stockOracle,
        network: NETWORK,
        roundId: latest.roundId.toString(),
        roundTimestamp: Number(latest.timestamp),
        priceAtomic: latest.price.toString(),
        window: signal.window,
      },
    });
  } catch (err) {
    res.status(503).json({ error: `oracle unavailable: ${(err as Error).message.split("\n")[0]}` });
  }
});

app.get("/api/feed", async (_req, res) => {
  try {
    const rounds = await readRounds();
    const latest = rounds[0]!;
    res.json({
      pair: "AVAX/USD",
      price: latest.price,
      updatedAt: new Date(latest.updatedAt * 1000).toISOString(),
      source: { chainlink: CHAINLINK_AVAX_USD_FUJI, network: "avalanche-fuji", roundId: latest.roundId },
      signal: momentumSignal(rounds),
      servedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ error: `price feed unavailable: ${(err as Error).message}` });
  }
});

app.listen(PORTS.provider, () => {
  console.log(`Hush demo provider on http://localhost:${PORTS.provider}  (${NETWORK})`);
  console.log(`  GET /api/feed  ${PRICE}  payTo ${provider.address}`);
  if (contracts.stockOracle) console.log(`  GET /api/signal?ticker=…  ${SIGNAL_PRICE}  horizon ${SIGNAL_HORIZON_SECONDS}s  oracle ${contracts.stockOracle}`);
  console.log(`  facilitator    ${URLS.facilitator}`);
});
