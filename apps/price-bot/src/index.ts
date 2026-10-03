/**
 * Hush price bot — posts one round per mock stock to MockStockOracle every PRICE_INTERVAL_SECONDS (default 60), all
 * tickers in a single transaction. Prices are synthetic (see walk.ts); they are public market data by design.
 *
 *   pnpm price-bot [--local] [--once]      env: PRICE_INTERVAL_SECONDS, PRICE_SEED
 *
 * Uses @hush/config/base (viem only) — no eERC SDK in this process. Needs PRICEBOT set as an oracle updater
 * (`pnpm bootstrap` does that).
 */
import { NETWORK, loadContracts, publicClient, signer, txLink } from "@hush/config/base";
import { STOCK_TICKERS, formatPrice, latestRound, mockStockOracleAbi, stockContracts, tickerToBytes32 } from "@hush/x402/contracts";
import { DEFAULT_PARAMS, PriceWalk, gaussian, rng, toAtomicCents } from "./walk.js";

const ONCE = process.argv.includes("--once");
const INTERVAL_MS = Number(process.env.PRICE_INTERVAL_SECONDS || 60) * 1000;
const SEED = Number(process.env.PRICE_SEED || 42);
const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} [price-bot] ${msg}`);

const contracts = loadContracts();
const { oracle } = stockContracts(contracts);
const bot = signer("PRICEBOT");

const allowed = await publicClient.readContract({ address: oracle, abi: mockStockOracleAbi, functionName: "isUpdater", args: [bot.address] });
if (!allowed) throw new Error(`PRICEBOT ${bot.address} is not an oracle updater — run \`pnpm bootstrap${NETWORK === "localhost" ? ":local" : ""}\``);

// Continue from the prices already on-chain, so restarts don't jump.
const walks = new Map<string, PriceWalk>();
let rounds = 0;
for (const t of STOCK_TICKERS) {
  const params = DEFAULT_PARAMS[t]!;
  const latest = await latestRound(publicClient, oracle, t).catch(() => undefined);
  rounds = Math.max(rounds, latest ? Number(latest.roundId) + 1 : 0);
  walks.set(t, new PriceWalk(latest ? Number(formatPrice(latest.price)) : params.anchor, params));
}
// Offset the seed by the rounds already posted: reproducible for a given chain state, but a restart never replays the
// noise sequence of the previous run.
const uniform = rng(SEED + rounds);

async function tick() {
  const prices = STOCK_TICKERS.map((t) => toAtomicCents(walks.get(t)!.step(gaussian(uniform))));
  const hash = await bot.walletClient.writeContract({
    address: oracle,
    abi: mockStockOracleAbi,
    functionName: "postPrices",
    args: [STOCK_TICKERS.map(tickerToBytes32), prices],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`postPrices reverted: ${hash}`);
  log(`${STOCK_TICKERS.map((t, i) => `${t} ${formatPrice(prices[i]!)}`).join(" · ")}  ${txLink(hash)}`);
}

log(`oracle ${oracle} on ${NETWORK} · updater ${bot.address} · every ${INTERVAL_MS / 1000}s · seed ${SEED}+${rounds}`);
await tick();
if (ONCE) process.exit(0);

let running = false;
setInterval(async () => {
  if (running) return; // never overlap: one postPrices in flight at a time
  running = true;
  try {
    await tick();
  } catch (err) {
    log(`tick failed: ${(err as Error).message.split("\n")[0]}`);
  } finally {
    running = false;
  }
}, INTERVAL_MS);
