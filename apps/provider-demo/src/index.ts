/**
 * Hush demo provider ("SignalCo") — paid APIs an AI trading agent would buy repeatedly.
 *
 *   GET /api/feed                $0.02   AVAX/USD from Chainlink on Fuji + a momentum signal
 *   GET /api/signal?ticker=NVDA  $0.02   latest signed mock-stock direction call (v2; NVDA, TSLA, SPY)
 *   GET /proof-of-alpha          free    Proof of Alpha: every call of the resolved, committed epochs (v2)
 *
 * Payable with x402 `exact` (public), `hush-credit` (private, the product) or `hush-direct` (private, reference),
 * all from one middleware line.
 *
 * v2 also runs "AlphaKing" (:4025, role ALPHAKING, `exact` only) in this process: same API, random calls with high
 * confidence, and a proof that leaves most of its losers out. Both providers' chain heads are committed to HushAlpha
 * by the COMMITTER key after every epoch.
 */
import { NETWORK, PORTS, URLS, loadContracts, publicClient, signer, stateTag, txLink, wallet } from "@hush/config";
import {
  DIRECTION,
  STOCK_TICKERS,
  type SignalRecordJson,
  type StockTicker,
  formatPrice,
  hushAlphaAbi,
  isStockTicker,
} from "@hush/x402/contracts";
import { type HushScheme, hushMiddleware } from "@hush/x402/server";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type PublicClient, createPublicClient, formatUnits, http, isAddressEqual, parseAbi } from "viem";
import type { LocalAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { type Direction, type Published, SignalBook, type Strategy } from "./signals.js";

const PRICE = process.env.FEED_PRICE || "$0.02";
const SIGNAL_PRICE = process.env.SIGNAL_PRICE || "$0.02";
// Proof of Alpha binds a call only when its epoch's head is committed — at the latest two epochs after it was issued
// (600 s epochs on Fuji, 60 s locally) — and grades it from then on. A horizon of 3 epochs leaves 1–2 epochs to grade.
const LOCAL = NETWORK === "localhost";
const SIGNAL_HORIZON_SECONDS = Number(process.env.SIGNAL_HORIZON_SECONDS || (LOCAL ? 180 : 1800));
/** One call per ticker per interval, whether or not anyone buys — the record can't depend on who is watching. */
const SIGNAL_INTERVAL_SECONDS = Number(process.env.SIGNAL_INTERVAL_SECONDS || (LOCAL ? 20 : 300));
/** Calls are stamped this far in the past (see SignalBookOptions.settleSec). */
const SIGNAL_SETTLE_SECONDS = 5;
/** Seconds after an epoch boundary before committing it: block time must be in the next epoch, and every call stamped
 * in the closed epoch (published up to SIGNAL_SETTLE_SECONDS later) must be in. */
const COMMIT_DELAY_SECONDS = Math.max(SIGNAL_SETTLE_SECONDS + 2, Number(process.env.COMMIT_DELAY_SECONDS || (LOCAL ? 8 : 10)));
const PROOF_WINDOW_EPOCHS = Number(process.env.PROOF_WINDOW_EPOCHS || (LOCAL ? 30 : 36));
const contracts = loadContracts();
const provider = wallet("PROVIDER");
const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

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
const stockSignal: Strategy = (_ticker, rounds, horizonSec) => {
  // Expected log move over the horizon = last return × φ/(1−φ) (momentum) + H × θ × (window mean − now) (reversion).
  // φ ≈ 0.25 and θ ≈ 0.01/round are the synthetic walk's (apps/price-bot/src/walk.ts); an EMA crossover scores ~49% on
  // it, this ~55–58% on directional calls in simulation. Calls within 0.1σ of zero are FLAT (no call).
  const logs = [...rounds].reverse().map((r) => Math.log(Number(r.price))); // oldest → newest
  if (logs.length < 3) return { direction: "FLAT", confidence: 0.5, momentumBps: 0 };
  const rets = logs.slice(1).map((x, i) => x - logs[i]!);
  const sd = Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length);
  const mean = logs.reduce((a, x) => a + x, 0) / logs.length;
  const spacing = Number(rounds[0]!.timestamp - rounds.at(-1)!.timestamp) / (rounds.length - 1);
  const H = Math.max(1, horizonSec / Math.max(1, spacing));
  const expected = rets.at(-1)! / 3 + 0.01 * H * (mean - logs.at(-1)!);
  const z = sd === 0 ? 0 : expected / (sd * Math.sqrt(H));
  const direction: Direction = Math.abs(z) < 0.1 ? "FLAT" : z > 0 ? "UP" : "DOWN";
  return { direction, confidence: Number((0.5 + 0.4 * Math.tanh(Math.abs(z))).toFixed(2)), momentumBps: Math.round(expected * 10_000) };
};

/** AlphaKing: a coin flip, always delivered with 85–95% confidence. */
const alphaKingSignal: Strategy = () => ({
  direction: Math.random() < 0.5 ? "UP" : "DOWN",
  confidence: Number((0.85 + Math.random() * 0.1).toFixed(2)),
  momentumBps: Math.round((Math.random() - 0.5) * 80),
});
/**
 * AlphaKing's proof keeps every win and about one loser in ten (picked by signature, so the proof is stable across
 * requests). Its claimed win rate is computed over exactly what it reveals — and verification fails at the first
 * epoch it doctored, because its committed heads include every call.
 */
const alphaKingReveal = (leaf: { signature: string }, grade: { outcome: string } | undefined) =>
  grade?.outcome !== "loss" || Number.parseInt(leaf.signature.slice(-6, -2), 16) % 10 === 0;

// ─── http ───
const app = express();

app.get("/", (_req, res) => {
  res.json({
    name: "SignalCo (Hush demo provider)",
    paid: { "GET /api/feed": PRICE, ...(contracts.stockOracle && { "GET /api/signal?ticker=NVDA|TSLA|SPY": SIGNAL_PRICE }) },
    schemes: ["hush-credit", "exact", "hush-direct"],
    payTo: provider.address,
    facilitator: URLS.facilitator,
    network: NETWORK,
    ...(signalCo && { proofOfAlpha: alphaInfo(signalCo, URLS.provider) }),
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

// ─── v2: signal books + Proof of Alpha ───
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const TAG = await stateTag();
const tickers = STOCK_TICKERS.filter((t) => contracts.stocks?.[t]);

const openBook = (name: string, account: LocalAccount, strategy: Strategy, baseUrl: string, reveal?: typeof alphaKingReveal) =>
  SignalBook.open({
    rounds: 60,
    settleSec: SIGNAL_SETTLE_SECONDS,
    name,
    signer: account,
    contracts: contracts as typeof contracts & { hushAlpha: Address; stockOracle: Address },
    publicClient: publicClient as PublicClient,
    horizonSec: SIGNAL_HORIZON_SECONDS,
    file: path.join(APP_DIR, ".data", `signals-${name.toLowerCase()}-${NETWORK}${TAG}.jsonl`),
    strategy,
    proofUrl: `${baseUrl}/proof-of-alpha`,
    reveal,
    windowEpochs: PROOF_WINDOW_EPOCHS,
    log,
  });

let signalCo: SignalBook | undefined;
let alphaKing: SignalBook | undefined;
if (contracts.stockOracle && contracts.hushAlpha) {
  signalCo = await openBook("SignalCo", provider.account, stockSignal, URLS.provider);
  alphaKing = await openBook("AlphaKing", signer("ALPHAKING").account, alphaKingSignal, URLS.alphaking, alphaKingReveal);
}
const books = [signalCo, alphaKing].filter((b): b is SignalBook => !!b);

/** What a provider publishes about its record. The claims are its own numbers; only a verified proof counts. */
const alphaInfo = (book: SignalBook, baseUrl: string) => ({
  name: book.opts.name,
  ...book.info(),
  proofUrl: `${baseUrl}/proof-of-alpha`,
  note: "claims are computed by the provider over the records it chooses to reveal — verify the proof (HushAlpha chain heads + oracle prices)",
});

const directionName = (d: number) => (Object.keys(DIRECTION) as Direction[]).find((k) => DIRECTION[k] === d) ?? "FLAT";

// Reject bad input before the paywall, so nobody is asked to pay for a 400.
const tickerGuard: express.RequestHandler = (req, res, next) => {
  const ticker = String(req.query.ticker ?? "").toUpperCase();
  if (!contracts.stockOracle || !contracts.hushAlpha) return void res.status(404).json({ error: "this deployment has no mock stocks / HushAlpha" });
  if (!isStockTicker(ticker) || !contracts.stocks?.[ticker]) {
    return void res.status(400).json({ error: `ticker must be one of ${STOCK_TICKERS.join(", ")}` });
  }
  next();
};

/** The paid signal: the provider's latest signed call for the ticker — the buyer keeps the record and its signature. */
const signalHandler =
  (book: SignalBook): express.RequestHandler =>
  async (req, res) => {
    const ticker = String(req.query.ticker).toUpperCase() as StockTicker;
    try {
      const p: Published | undefined = book.latest.get(ticker) ?? (await book.publish(ticker));
      if (!p) return void res.status(503).json({ error: `no oracle rounds for ${ticker} yet` });
      const r = p.leaf.record as SignalRecordJson;
      res.json({
        provider: book.subject,
        ticker,
        direction: directionName(r.direction),
        confidence: r.confidenceBps / 10_000,
        price: Number(formatPrice(BigInt(r.price))),
        issuedAt: Number(r.issuedAt),
        horizonSec: Number(r.horizonSec),
        momentumBps: p.momentumBps,
        source: {
          oracle: contracts.stockOracle,
          network: NETWORK,
          roundId: p.round.roundId.toString(),
          roundTimestamp: Number(p.round.timestamp),
          priceAtomic: r.price,
          window: p.window,
        },
        record: r,
        signature: p.leaf.signature,
        epoch: p.epoch.toString(),
      });
    } catch (err) {
      res.status(503).json({ error: `oracle unavailable: ${(err as Error).message.split("\n")[0]}` });
    }
  };

const proofHandler =
  (book: SignalBook): express.RequestHandler =>
  async (req, res) => {
    let from: bigint | undefined;
    let to: bigint | undefined;
    try {
      if (req.query.from !== undefined) from = BigInt(String(req.query.from));
      if (req.query.to !== undefined) to = BigInt(String(req.query.to));
    } catch {
      return void res.status(400).json({ error: "from/to must be epoch numbers" });
    }
    await book.refreshClaims().catch(() => undefined); // AlphaKing needs fresh grades to know which losers to hide
    const proof = book.proof(from, to);
    res.status("error" in proof ? 404 : 200).json(proof);
  };

const signalRoute = (book: SignalBook, baseUrl: string) => ({
  price: SIGNAL_PRICE,
  description: `${book.opts.name}: mock-stock direction call (NVDA, TSLA, SPY), signed and committed to HushAlpha`,
  // The 402 carries the provider's claimed record, so a buyer can check it before paying.
  unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment required", proofOfAlpha: alphaInfo(book, baseUrl) } }),
});

if (signalCo) app.use("/api/signal", tickerGuard);

// The one line that makes the routes payable with all three schemes.
app.use(
  hushMiddleware({
    payTo: provider.address,
    contracts,
    facilitatorUrl: URLS.facilitator,
    routes: {
      "GET /api/feed": { price: PRICE, description: "AVAX/USD (Chainlink on Fuji) + momentum signal" },
      ...(signalCo && { "GET /api/signal": signalRoute(signalCo, URLS.provider) }),
    },
    minTopUp: 1_000_000n,
  }),
);

if (signalCo) {
  app.get("/api/signal", signalHandler(signalCo));
  app.get("/proof-of-alpha", proofHandler(signalCo));
}

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

// ─── AlphaKing: same API on its own port, public `exact` only ───
if (alphaKing) {
  const king = express();
  const payTo = alphaKing.subject;
  king.get("/", (_req, res) => {
    res.json({
      name: "AlphaKing Signals",
      tagline: "90%+ win rate. Trust us.",
      paid: { "GET /api/signal?ticker=NVDA|TSLA|SPY": SIGNAL_PRICE },
      schemes: ["exact"],
      payTo,
      facilitator: URLS.facilitator,
      network: NETWORK,
      proofOfAlpha: alphaInfo(alphaKing, URLS.alphaking),
    });
  });
  king.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  king.use("/api/signal", tickerGuard);
  king.use(
    hushMiddleware({
      payTo,
      contracts,
      facilitatorUrl: URLS.facilitator,
      schemes: ["exact"] satisfies HushScheme[],
      routes: { "GET /api/signal": signalRoute(alphaKing, URLS.alphaking) },
    }),
  );
  king.get("/api/signal", signalHandler(alphaKing));
  king.get("/proof-of-alpha", proofHandler(alphaKing));
  king.listen(PORTS.alphaking, () => log(`AlphaKing on http://localhost:${PORTS.alphaking}  payTo ${payTo}  (exact only)`));
}

// ─── publishing + chain-head commits ───
if (books.length) {
  // A separate key commits for both providers: the PROVIDER key also spends eERC in the facilitator process, and two
  // processes sharing one key would race for nonces.
  const committer = signer("COMMITTER", { managedNonce: true });
  for (const book of books) {
    const authorised = (await publicClient.readContract({ address: contracts.hushAlpha!, abi: hushAlphaAbi, functionName: "committerOf", args: [book.subject] })) as Address;
    if (!isAddressEqual(authorised, committer.address)) {
      throw new Error(`${book.opts.name} (${book.subject}) has not authorised COMMITTER ${committer.address} on HushAlpha — run \`pnpm bootstrap${LOCAL ? ":local" : ""}\``);
    }
  }
  const L = books[0]!.epochLen;

  const publishAll = async (book: SignalBook) => {
    for (const t of tickers) await book.publish(t).catch((err: Error) => log(`${book.opts.name}: publish ${t} failed — ${err.message.split("\n")[0]}`));
  };
  // One commit at a time: a hardhat node rejects a nonce that arrives ahead of its predecessor (no queueing when
  // automining), and there is a whole epoch to get both in.
  const commitAll = async () => {
    for (const book of books) {
      try {
        const r = await book.commitClosed(committer.walletClient);
        if (r) log(`${book.opts.name}: committed head of epoch ${r.epoch} (${book.chain.leaves(r.epoch).length} calls)  ${txLink(r.tx)}`);
      } catch (err) {
        log(`${book.opts.name}: commit failed — ${(err as Error).message.split("\n")[0]}`);
      }
    }
    await Promise.all(books.map((book) => book.refreshClaims().catch((err: Error) => log(`${book.opts.name}: grading failed — ${err.message.split("\n")[0]}`))));
  };
  // Every epoch, a few seconds after it closes — with or without calls in it (empty epochs commit a heartbeat).
  const scheduleCommits = () => {
    const now = Date.now() / 1000;
    const next = (Math.floor(now / L) + 1) * L + COMMIT_DELAY_SECONDS;
    setTimeout(() => void commitAll().finally(scheduleCommits), (next - now) * 1000);
  };
  if (Date.now() / 1000 - Math.floor(Date.now() / 1000 / L) * L >= COMMIT_DELAY_SECONDS) await commitAll();
  scheduleCommits();

  await Promise.all(books.map(publishAll));
  setInterval(() => void Promise.all(books.map(publishAll)), SIGNAL_INTERVAL_SECONDS * 1000);
}

app.listen(PORTS.provider, () => {
  console.log(`Hush demo provider on http://localhost:${PORTS.provider}  (${NETWORK})`);
  console.log(`  GET /api/feed  ${PRICE}  payTo ${provider.address}`);
  if (signalCo) {
    console.log(`  GET /api/signal?ticker=…  ${SIGNAL_PRICE}  horizon ${SIGNAL_HORIZON_SECONDS}s  every ${SIGNAL_INTERVAL_SECONDS}s  oracle ${contracts.stockOracle}`);
    console.log(`  GET /proof-of-alpha       epochs of ${signalCo.epochLen}s · genesis ${signalCo.chain.genesisEpoch} · HushAlpha ${contracts.hushAlpha}`);
  }
  console.log(`  facilitator    ${URLS.facilitator}`);
});
